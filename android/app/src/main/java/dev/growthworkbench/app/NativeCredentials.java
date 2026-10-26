package dev.growthworkbench.app;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import org.json.JSONObject;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/** Keystore contains only nonexportable AES keys; private atomic files contain ciphertext. */
final class NativeCredentials {
 private static final String ALIAS="growth-workbench-v2.credentials";
 private final File directory;
 NativeCredentials(Context context) throws Exception {directory=NativeIO.directory(context,"credentials-v2");}
 private SecretKey key(boolean create) throws Exception {KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);if(store.containsAlias(ALIAS))return (SecretKey)store.getKey(ALIAS,null);if(!create)throw new SecurityException("REPAIR_DEVICE_REQUIRED");KeyGenerator generator=KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES,"AndroidKeyStore");generator.init(new KeyGenParameterSpec.Builder(ALIAS,KeyProperties.PURPOSE_ENCRYPT|KeyProperties.PURPOSE_DECRYPT).setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).setRandomizedEncryptionRequired(true).build());return generator.generateKey();}
 String get(String name) throws Exception {File file=new File(directory,NativeIO.hash(name)+".json");if(!NativeIO.exists(file))return null;try{JSONObject payload=NativeIO.json(file);Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key(false),new GCMParameterSpec(128,Base64.decode(payload.getString("iv"),Base64.NO_WRAP)));cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));return new String(cipher.doFinal(Base64.decode(payload.getString("ciphertext"),Base64.NO_WRAP)),StandardCharsets.UTF_8);}catch(Exception cause){throw new SecurityException("REPAIR_DEVICE_REQUIRED");}}
 void set(String name,String value) throws Exception {File file=new File(directory,NativeIO.hash(name)+".json");if(value==null){new android.util.AtomicFile(file).delete();return;}if(value.length()>65536)throw new SecurityException("CREDENTIAL_TOO_LARGE");Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.ENCRYPT_MODE,key(true));cipher.updateAAD(name.getBytes(StandardCharsets.UTF_8));JSONObject payload=new JSONObject().put("iv",Base64.encodeToString(cipher.getIV(),Base64.NO_WRAP)).put("ciphertext",Base64.encodeToString(cipher.doFinal(value.getBytes(StandardCharsets.UTF_8)),Base64.NO_WRAP));NativeIO.json(file,payload);}
}
