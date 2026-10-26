package dev.growthworkbench.app;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyInfo;
import android.security.keystore.KeyProperties;
import android.util.AtomicFile;
import android.util.Base64;
import org.json.JSONObject;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.time.Instant;
import java.util.Date;
import java.util.regex.Pattern;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;

/** Raw inbox URLs use per-entry provider-expiring keys. The long-lived store gets sanitized notes only. */
final class NativeShareInputs {
    private static final long MAX_AGE = 86400000L;
    private static final Pattern URL = Pattern.compile("https?://[^\\s<>\"']+", Pattern.CASE_INSENSITIVE);
    private final File directory;
    private final File legacyDirectory;
    private final NativeCredentials notes;

    NativeShareInputs(Context context, NativeCredentials notes) throws Exception {
        directory = NativeIO.directory(context, "share-inputs-v3");
        legacyDirectory = NativeIO.directory(context, "credentials-v2");
        this.notes = notes;
    }

    static String aliasFor(String id) throws Exception {
        return "growth-workbench-v3.share-url." + NativeIO.hash(id);
    }

    static String noteKey(String id) {return "share-note-v3:" + id;}

    private File file(String id) throws Exception {return new File(directory, NativeIO.hash(id) + ".json");}
    private KeyStore keyStore() throws Exception {
        KeyStore store = KeyStore.getInstance("AndroidKeyStore");
        store.load(null);
        return store;
    }

    private long receivedDeadline(JSONObject receipt) {
        try {return Math.addExact(Instant.parse(receipt.getString("receivedAt")).toEpochMilli(), MAX_AGE);}
        catch (Exception invalid) {return 1;}
    }

    private JSONObject note(String id) throws Exception {
        String value = notes.get(noteKey(id));
        return value == null ? new JSONObject() : new JSONObject(value);
    }

    private String sanitized(String text) {return URL.matcher(text).replaceAll("[网址授权已过期，请重新分享]");}

    private void needsReshare(JSONObject receipt) throws Exception {
        receipt.put("status", "needs-reshare").put("message", "网址授权已过期或无法读取，请重新分享；已保存的目录、文字和原文件仍保留");
    }

    private long keyDeadline(SecretKey key) throws Exception {
        KeyInfo info = (KeyInfo) SecretKeyFactory.getInstance(key.getAlgorithm(), "AndroidKeyStore").getKeySpec(key, KeyInfo.class);
        Date end = info.getKeyValidityForConsumptionEnd();
        if (end == null) throw new GeneralSecurityException("SHARE_KEY_POLICY_INVALID");
        return end.getTime();
    }

    /** Deadline is immutable or can only shorten. This API never accepts an extension beyond 24h. */
    long protectRaw(String id, String text, long requestedDeadline) throws Exception {
        long now = System.currentTimeMillis();
        long deadline = Math.min(requestedDeadline, Math.addExact(now, MAX_AGE));
        File target = file(id);
        if (NativeIO.exists(target)) deadline = Math.min(deadline, NativeIO.json(target).getLong("expiresAt"));
        KeyStore store = keyStore();
        String alias = aliasFor(id);
        SecretKey key = store.containsAlias(alias) ? (SecretKey) store.getKey(alias, null) : null;
        if (key != null) {
            long existingDeadline = keyDeadline(key);
            if (existingDeadline > deadline) {
                // An earlier migrated deadline must not keep a later provider policy.
                removeSecret(id); key = null;
            } else deadline = Math.min(deadline, existingDeadline);
        }
        if (deadline <= now) {removeSecret(id);return deadline;}
        if (key == null) {
            KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
            generator.init(new KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setKeySize(256)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .setKeyValidityForConsumptionEnd(new Date(deadline))
                .setKeyValidityForOriginationEnd(new Date(deadline))
                .build());
            key = generator.generateKey();
        }
        if (keyDeadline(key) > deadline) throw new GeneralSecurityException("SHARE_KEY_POLICY_INVALID");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.ENCRYPT_MODE, key);
        cipher.updateAAD((id + ":" + deadline).getBytes(StandardCharsets.UTF_8));
        JSONObject payload = new JSONObject().put("version", 1).put("expiresAt", deadline)
            .put("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
            .put("ciphertext", Base64.encodeToString(cipher.doFinal(text.getBytes(StandardCharsets.UTF_8)), Base64.NO_WRAP));
        NativeIO.json(target, payload);
        return deadline;
    }

    String pasted(String id) throws Exception {
        File target = file(id);
        if (!NativeIO.exists(target)) return null;
        if (NativeIO.json(target).getLong("expiresAt") <= System.currentTimeMillis()) {remove(id); return null;}
        try {return raw(id);} catch (GeneralSecurityException expired) {remove(id); return null;}
    }

    private String raw(String id) throws Exception {
        File target = file(id);
        if (!NativeIO.exists(target)) throw new GeneralSecurityException("SHARE_KEY_MISSING");
        JSONObject payload = NativeIO.json(target);
        KeyStore store = keyStore();
        SecretKey key = (SecretKey) store.getKey(aliasFor(id), null);
        if (key == null || keyDeadline(key) > payload.getLong("expiresAt")) throw new GeneralSecurityException("SHARE_KEY_POLICY_INVALID");
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        // AndroidKeyStore enforces consumption expiry, even when no app cleanup ran.
        cipher.init(Cipher.DECRYPT_MODE, key, new GCMParameterSpec(128, Base64.decode(payload.getString("iv"), Base64.NO_WRAP)));
        cipher.updateAAD((id + ":" + payload.getLong("expiresAt")).getBytes(StandardCharsets.UTF_8));
        return new String(cipher.doFinal(Base64.decode(payload.getString("ciphertext"), Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }

    private void removeLegacy(String id) throws Exception {
        String legacyKey = "share-content:" + id;
        notes.set(legacyKey, null);
        File legacy = new File(legacyDirectory, NativeIO.hash(legacyKey) + ".json");
        if (NativeIO.exists(legacy) || new File(legacy.getPath() + ".new").exists()) throw new IOException("LEGACY_SHARE_INPUT_REMOVE_FAILED");
    }

    /** Persist safe fallback first, remove legacy raw copies before attempting new encryption. */
    void migrateLegacy(JSONObject receipt) throws Exception {
        String id = receipt.getString("deliveryId");
        String old = notes.get("share-content:" + id);
        if (old == null) return;
        JSONObject legacy = new JSONObject(old);
        String text = legacy.optString("text", "");
        boolean hadUrl = URL.matcher(text).find();
        long deadline = Math.min(receivedDeadline(receipt), legacy.optLong("expiresAt", Long.MAX_VALUE));
        JSONObject fallback = new JSONObject().put("text", hadUrl ? sanitized(text) : text).put("hadUrl", hadUrl);
        if (hadUrl) fallback.put("expiresAt", deadline);
        notes.set(noteKey(id), fallback.toString());
        removeLegacy(id);
        if (hadUrl) {
            try {if (protectRaw(id, text, deadline) <= System.currentTimeMillis()) needsReshare(receipt);}
            catch (GeneralSecurityException error) {removeSecret(id);needsReshare(receipt);}
        }
    }

    void storeText(JSONObject receipt, String text) throws Exception {
        String id = receipt.getString("deliveryId");
        JSONObject previous = note(id);
        boolean containsUrl = URL.matcher(text).find();
        boolean hadUrl = containsUrl || previous.optBoolean("hadUrl", false);
        long deadline = Math.min(receivedDeadline(receipt), previous.optLong("expiresAt", Long.MAX_VALUE));
        JSONObject fallback = new JSONObject().put("text", containsUrl ? sanitized(text) : text).put("hadUrl", hadUrl);
        if (hadUrl) fallback.put("expiresAt", deadline);
        notes.set(noteKey(id), fallback.toString());
        removeLegacy(id);
        if (containsUrl) {
            try {if (protectRaw(id, text, deadline) <= System.currentTimeMillis()) needsReshare(receipt);}
            catch (GeneralSecurityException error) {removeSecret(id);needsReshare(receipt);}
        } else if (hadUrl) needsReshare(receipt);
    }

    String text(JSONObject receipt) throws Exception {
        String id = receipt.getString("deliveryId");
        migrateLegacy(receipt);
        JSONObject fallback = note(id);
        if (!fallback.has("text")) return null;
        if (!fallback.optBoolean("hadUrl", false)) return fallback.getString("text");
        try {return raw(id);}
        catch (GeneralSecurityException error) {removeSecret(id);needsReshare(receipt);return fallback.getString("text");}
    }

    private void removeSecret(String id) throws Exception {
        KeyStore store = keyStore();
        store.deleteEntry(aliasFor(id));
        File target = file(id);
        new AtomicFile(target).delete();
        if (NativeIO.exists(target) || new File(target.getPath() + ".new").exists()) throw new IOException("SHARE_INPUT_REMOVE_FAILED");
    }

    void remove(String id) throws Exception {
        // Key deletion comes first: a crash cannot leave usable orphan URL ciphertext.
        removeSecret(id);
        notes.set(noteKey(id), null);
        removeLegacy(id);
    }
}
