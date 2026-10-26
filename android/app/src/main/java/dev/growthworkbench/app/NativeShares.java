package dev.growthworkbench.app;

import android.content.Context;
import android.content.Intent;
import android.content.ClipData;
import android.net.Uri;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.time.Instant;
import java.util.*;

/** Receipt is durable before copying. Raw share content is encrypted separately from event metadata. */
final class NativeShares {
 private final File inbox,ignored;private final NativeFiles files;private final NativeShareInputs inputs;
 NativeShares(Context context,NativeFiles files,NativeCredentials credentials) throws Exception {inbox=NativeIO.directory(context,"share-inbox-v2");ignored=new File(inbox,"ignored");if(!ignored.isDirectory()&&!ignored.mkdirs())throw new java.io.IOException("PRIVATE_STORAGE_UNAVAILABLE");this.files=files;this.inputs=new NativeShareInputs(context,credentials);migrateExisting(inbox);migrateExisting(ignored);}
 private File event(String id){if(!id.matches("[a-f0-9-]{36}"))throw new IllegalArgumentException("INVALID_DELIVERY");return new File(inbox,id+".json");}
 private File archived(String id){event(id);return new File(ignored,id+".json");}
 private void migrateExisting(File directory) throws Exception {File[] entries=directory.listFiles((dir,name)->name.matches("[a-f0-9-]{36}\\.json(?:\\.bak)?"));if(entries==null)return;Set<String> ids=new HashSet<>();for(File file:entries)ids.add(file.getName().replace(".json.bak","").replace(".json",""));for(String id:ids){File file=new File(directory,id+".json");JSONObject receipt=NativeIO.json(file);inputs.migrateLegacy(receipt);NativeIO.json(file,receipt);}}
 private JSONObject load(File file,String id) throws Exception {
  JSONObject value=NativeIO.json(file);
  String text=inputs.text(value);
  // Persist only metadata/status. Full text must never enter an inbox JSON file.
  NativeIO.json(file,value);
  if(text!=null)value.put("text",text);
  return value;
 }
 private JSONObject load(String id) throws Exception {return load(event(id),id);}
 private void save(File target,JSONObject value) throws Exception {String id=value.getString("deliveryId");JSONObject stored=new JSONObject(value.toString());stored.remove("dismissed");if(stored.has("text")){String text=stored.getString("text");stored.remove("text");inputs.storeText(stored,text);}NativeIO.json(target,stored);}
 private void save(JSONObject value) throws Exception {save(event(value.getString("deliveryId")),value);}
 void receive(Intent intent,String id) throws Exception {
  if(NativeIO.exists(event(id))||NativeIO.exists(archived(id)))return;
  JSONObject receipt=new JSONObject().put("deliveryId",id).put("receivedAt",Instant.now().toString()).put("status","copying").put("files",new JSONArray());
  CharSequence text=intent.getCharSequenceExtra(Intent.EXTRA_TEXT);if(text!=null){String body=text.toString();if(body.length()>10000){receipt.put("status","needs-reshare").put("message","分享文字超过 10000 字，请拆分后重新分享");save(receipt);return;}receipt.put("text",body);}save(receipt);
  try{LinkedHashSet<Uri> uris=new LinkedHashSet<>();if(Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction())){ArrayList<Uri> streams=intent.getParcelableArrayListExtra(Intent.EXTRA_STREAM);if(streams!=null)uris.addAll(streams);}else{Uri stream=intent.getParcelableExtra(Intent.EXTRA_STREAM);if(stream!=null)uris.add(stream);}ClipData clips=intent.getClipData();if(clips!=null)for(int i=0;i<clips.getItemCount();i++){Uri uri=clips.getItemAt(i).getUri();if(uri!=null)uris.add(uri);}if(uris.size()>100)throw new IllegalArgumentException("TOO_MANY_FILES");JSONArray staged=new JSONArray();for(Uri uri:uris){if(!"content".equals(uri.getScheme()))throw new SecurityException("UNSUPPORTED_URI");staged.put(files.copyUri(uri));}receipt.put("files",staged).put("status","ready");save(receipt);}catch(Exception error){receipt.put("status","needs-reshare").put("message",error.getMessage()!=null&&error.getMessage().equals("FILE_TOO_LARGE")?"文件超过 1 GiB，请选择较小文件重新分享":"文件授权或复制未完成，请保留原文件并重新分享");save(receipt);}
 }
 JSONArray pending() throws Exception {return pending(false);}
 JSONArray pending(boolean includeIgnored) throws Exception {JSONArray result=new JSONArray();append(result,inbox,false);if(includeIgnored)append(result,ignored,true);return result;}
 private void append(JSONArray result,File directory,boolean dismissed) throws Exception {File[] entries=directory.listFiles((dir,name)->name.matches("[a-f0-9-]{36}\\.json(?:\\.bak)?"));if(entries==null)return;SortedSet<String> ids=new TreeSet<>();for(File file:entries)ids.add(file.getName().replace(".json.bak","").replace(".json",""));for(String id:ids){if(!dismissed&&NativeIO.exists(archived(id)))continue;JSONObject value=load(dismissed?archived(id):event(id),id);if("copying".equals(value.optString("status"))){value.put("status","needs-reshare").put("message","复制被中断，临时授权无法保留，请重新分享");save(dismissed?archived(id):event(id),value);}if(dismissed)value.put("dismissed",true);result.put(value);}}
 private void owner(JSONObject value,String account){String owner=value.optString("accountId",account);if(!owner.equals(account))throw new SecurityException("SHARE_ACCOUNT_MISMATCH");}
 String claim(String id,String account) throws Exception {if(!NativeIO.exists(event(id))||NativeIO.exists(archived(id)))throw new IllegalStateException("SHARE_MISSING");JSONObject value=load(id);if(!"ready".equals(value.optString("status")))throw new IllegalStateException("SHARE_NEEDS_RESHARE");owner(value,account);value.put("accountId",account);save(value);return account;}
 void dismiss(String id,String account) throws Exception {if(!NativeIO.exists(event(id)))throw new IllegalStateException("SHARE_MISSING");JSONObject value=load(id);owner(value,account);value.put("accountId",account);save(archived(id),value);new android.util.AtomicFile(event(id)).delete();}
 void restore(String id,String account) throws Exception {if(!NativeIO.exists(archived(id)))throw new IllegalStateException("SHARE_MISSING");JSONObject value=load(archived(id),id);owner(value,account);save(value);new android.util.AtomicFile(archived(id)).delete();}
 void acknowledge(String id,String account) throws Exception {JSONObject value=load(id);if(!account.equals(value.optString("accountId")))throw new SecurityException("SHARE_ACCOUNT_MISMATCH");inputs.remove(id);new android.util.AtomicFile(event(id)).delete();/* Original files stay persistent until cloud verification, never reclaimed as cache. */}
}
