package dev.growthworkbench.app;

import android.content.Context;
import android.content.Intent;
import android.security.keystore.KeyInfo;
import android.util.Base64;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;
import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import java.io.File;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.util.UUID;
import static org.junit.Assert.*;

/** Direct provider operations verify expiry independently of inbox/JS date checks. */
@RunWith(AndroidJUnit4.class)
public class ShareInputExpiryTest {
 private Context context(){return InstrumentationRegistry.getInstrumentation().getTargetContext();}
 private KeyStore keyStore() throws Exception {KeyStore store=KeyStore.getInstance("AndroidKeyStore");store.load(null);return store;}
 private File secretFile(String id) throws Exception {return new File(NativeIO.directory(context(),"share-inputs-v3"),NativeIO.hash(id)+".json");}
 private File receiptFile(String id) throws Exception {return new File(NativeIO.directory(context(),"share-inbox-v2"),id+".json");}
 private JSONObject find(NativeShares shares,String id) throws Exception {JSONArray items=shares.pending(true);for(int i=0;i<items.length();i++)if(id.equals(items.getJSONObject(i).getString("deliveryId")))return items.getJSONObject(i);fail("receipt missing");return null;}
 private byte[] directDecrypt(SecretKey key,String id,JSONObject payload) throws Exception {Cipher cipher=Cipher.getInstance("AES/GCM/NoPadding");cipher.init(Cipher.DECRYPT_MODE,key,new GCMParameterSpec(128,Base64.decode(payload.getString("iv"),Base64.NO_WRAP)));cipher.updateAAD((id+":"+payload.getLong("expiresAt")).getBytes(StandardCharsets.UTF_8));return cipher.doFinal(Base64.decode(payload.getString("ciphertext"),Base64.NO_WRAP));}
 @Test public void providerRejectsDecryptionAfterDeadlineWithoutInboxLoad() throws Exception {
  String id=UUID.randomUUID().toString(),raw="https://example.com/manual.pdf?signature=provider-expiry";
  NativeShareInputs inputs=new NativeShareInputs(context(),new NativeCredentials(context()));
  long deadline=System.currentTimeMillis()+4000;
  inputs.protectRaw(id,raw,deadline);
  JSONObject ciphertext=NativeIO.json(secretFile(id));
  SecretKey key=(SecretKey)keyStore().getKey(NativeShareInputs.aliasFor(id),null);
  KeyInfo info=(KeyInfo)SecretKeyFactory.getInstance(key.getAlgorithm(),"AndroidKeyStore").getKeySpec(key,KeyInfo.class);
  assertNotNull(info.getKeyValidityForConsumptionEnd());assertTrue(info.getKeyValidityForConsumptionEnd().getTime()<=deadline);
  assertEquals(raw,new String(directDecrypt(key,id,ciphertext),StandardCharsets.UTF_8));
  android.os.SystemClock.sleep(Math.max(0,deadline-System.currentTimeMillis())+1200);
  // No NativeShares.load, input helper read or cleanup has run since encryption.
  assertTrue(secretFile(id).exists());assertTrue(keyStore().containsAlias(NativeShareInputs.aliasFor(id)));
  try{directDecrypt(key,id,ciphertext);fail("Keystore provider must deny expired key consumption independently");}catch(GeneralSecurityException expected){}
  inputs.remove(id);
 }
 @Test public void unexpiredShareDeadlineDoesNotExtendAndAckRemovesKeyAndCiphertext() throws Exception {
  Context context=context();String id=UUID.randomUUID().toString(),raw="保留笔记 https://example.com/a.pdf?signature=unexpired";
  NativeCredentials credentials=new NativeCredentials(context);NativeShares shares=new NativeShares(context,new NativeFiles(context),credentials);
  shares.receive(new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT,raw),id);
  assertEquals(raw,find(shares,id).getString("text"));assertNull(credentials.get("share-content:"+id));
  assertFalse(credentials.get(NativeShareInputs.noteKey(id)).contains("signature=unexpired"));
  long deadline=NativeIO.json(secretFile(id)).getLong("expiresAt");
  shares.claim(id,"owner");shares.dismiss(id,"owner");shares.restore(id,"owner");
  assertEquals(deadline,NativeIO.json(secretFile(id)).getLong("expiresAt"));
  SecretKey key=(SecretKey)keyStore().getKey(NativeShareInputs.aliasFor(id),null);
  KeyInfo info=(KeyInfo)SecretKeyFactory.getInstance(key.getAlgorithm(),"AndroidKeyStore").getKeySpec(key,KeyInfo.class);
  assertTrue(info.getKeyValidityForConsumptionEnd().getTime()<=deadline);
  shares.acknowledge(id,"owner");
  assertFalse(keyStore().containsAlias(NativeShareInputs.aliasFor(id)));assertFalse(NativeIO.exists(secretFile(id)));
  assertNull(credentials.get(NativeShareInputs.noteKey(id)));assertNull(credentials.get("share-content:"+id));
 }
 @Test public void expiredSharePreservesNotesAndFileReferencesWithVisibleReshare() throws Exception {
  Context context=context();String id=UUID.randomUUID().toString();NativeCredentials credentials=new NativeCredentials(context);
  NativeShareInputs inputs=new NativeShareInputs(context,credentials);
  long deadline=System.currentTimeMillis()+4000;
  JSONObject receipt=new JSONObject().put("deliveryId",id).put("receivedAt",java.time.Instant.ofEpochMilli(deadline-86400000L).toString()).put("status","ready").put("files",new JSONArray().put(new JSONObject().put("token","kept-original").put("name","original.pdf").put("mime","application/pdf").put("size",4)));
  inputs.storeText(receipt,"这段学习笔记要保留 https://example.com/a.pdf?signature=expired-visible");NativeIO.json(receiptFile(id),receipt);
  android.os.SystemClock.sleep(Math.max(0,deadline-System.currentTimeMillis())+1200);
  NativeShares shares=new NativeShares(context,new NativeFiles(context),credentials);JSONObject visible=find(shares,id);
  assertEquals("needs-reshare",visible.getString("status"));assertTrue(visible.getString("message").contains("重新分享"));assertTrue(visible.getString("text").contains("这段学习笔记要保留"));assertFalse(visible.getString("text").contains("expired-visible"));assertEquals("kept-original",visible.getJSONArray("files").getJSONObject(0).getString("token"));
  assertFalse(keyStore().containsAlias(NativeShareInputs.aliasFor(id)));assertFalse(NativeIO.exists(secretFile(id)));
  shares.dismiss(id,"owner");shares.restore(id,"owner");assertTrue(find(shares,id).getString("text").contains("这段学习笔记要保留"));
 }
 @Test public void startupMigratesLegacyRawCopiesWithoutChangingOrdinaryCredentials() throws Exception {
  Context context=context();NativeCredentials credentials=new NativeCredentials(context);String ordinary="ordinary-login-"+UUID.randomUUID();credentials.set(ordinary,"keep-login-token");
  String id=UUID.randomUUID().toString();long deadline=System.currentTimeMillis()+60000;JSONObject receipt=new JSONObject().put("deliveryId",id).put("receivedAt",java.time.Instant.ofEpochMilli(deadline-86400000L).toString()).put("status","ready").put("files",new JSONArray());NativeIO.json(receiptFile(id),receipt);
  credentials.set("share-content:"+id,new JSONObject().put("text","旧笔记 https://example.com/a.pdf?signature=legacy-private").put("expiresAt",deadline).toString());
  File legacy=new File(NativeIO.directory(context,"credentials-v2"),NativeIO.hash("share-content:"+id)+".json");
  new NativeShares(context,new NativeFiles(context),credentials);
  assertNull(credentials.get("share-content:"+id));assertFalse(NativeIO.exists(legacy));assertFalse(new File(legacy.getPath()+".new").exists());
  assertFalse(credentials.get(NativeShareInputs.noteKey(id)).contains("legacy-private"));
  JSONObject payload=NativeIO.json(secretFile(id));assertTrue(payload.getLong("expiresAt")<=deadline);
  SecretKey key=(SecretKey)keyStore().getKey(NativeShareInputs.aliasFor(id),null);assertTrue(new String(directDecrypt(key,id,payload),StandardCharsets.UTF_8).contains("legacy-private"));
  assertEquals("keep-login-token",credentials.get(ordinary));credentials.set(ordinary,null);
 }
}
