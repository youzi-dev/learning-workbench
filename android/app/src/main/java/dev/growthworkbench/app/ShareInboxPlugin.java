package dev.growthworkbench.app;

import android.Manifest;
import android.app.Activity;
import android.content.*;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.util.Base64;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.*;
import com.getcapacitor.annotation.*;
import org.json.*;
import java.io.*;
import java.util.*;

@CapacitorPlugin(name="ShareInbox",permissions={@Permission(alias="notifications",strings={Manifest.permission.POST_NOTIFICATIONS})})
public final class ShareInboxPlugin extends Plugin {
 private interface Work {JSONObject run(NativeServices services) throws Exception;}
 private void perform(PluginCall call,Work work){NativeIO.SERIAL.execute(()->{try{JSONObject result=work.run(NativeServices.get(getContext()));call.resolve(result==null?new JSObject():JSObject.fromJSONObject(result));}catch(Exception error){String code=error.getMessage();if(code==null||!code.matches("[A-Z_]{3,80}"))code="NATIVE_OPERATION_FAILED";call.reject(code,code);}});}
 void inboxChanged(){notifyListeners("inboxChanged",new JSObject());}
 @Override protected void handleOnResume(){notifyListeners("foreground",new JSObject());NativeIO.SERIAL.execute(()->{try{NativeServices.get(getContext()).notifications.restore();}catch(Exception ignored){}});}
 @PluginMethod public void repositoryOpen(PluginCall call){perform(call,s->s.repository.open(NativeIO.required(call.getData(),"accountId")));}
 @PluginMethod public void repositorySnapshot(PluginCall call){perform(call,s->s.repository.snapshot(NativeIO.required(call.getData(),"handle")));}
 @PluginMethod public void repositoryCommit(PluginCall call){perform(call,s->{s.repository.commit(NativeIO.required(call.getData(),"handle"),call.getData().getLong("revision"),call.getData().getJSONObject("state"));return null;});}
 @PluginMethod public void repositoryClose(PluginCall call){perform(call,s->{s.repository.close(NativeIO.required(call.getData(),"handle"));return null;});}
 @PluginMethod public void credentialGet(PluginCall call){perform(call,s->{String value=s.credentials.get(NativeIO.required(call.getData(),"key"));return new JSONObject().put("value",value==null?JSONObject.NULL:value);});}
 @PluginMethod public void credentialSet(PluginCall call){perform(call,s->{s.credentials.set(NativeIO.required(call.getData(),"key"),call.getData().isNull("value")?null:call.getData().getString("value"));return null;});}
 private String metadataKey(PluginCall call) throws Exception {String key=NativeIO.required(call.getData(),"key");if(!key.equals("connection")&&!key.matches("module:(journal|tasks|calendar|library|learning)"))throw new SecurityException("INVALID_METADATA_KEY");return key;}
 @PluginMethod public void metadataGet(PluginCall call){perform(call,s->{JSONObject values=NativeIO.json(new File(NativeIO.directory(getContext(),"metadata-v2"),"device.json"));return new JSONObject().put("value",values.opt(metadataKey(call))==null?JSONObject.NULL:values.get(metadataKey(call)));});}
 @PluginMethod public void metadataSet(PluginCall call){perform(call,s->{File file=new File(NativeIO.directory(getContext(),"metadata-v2"),"device.json");JSONObject values=NativeIO.json(file);String key=metadataKey(call);if(call.getData().isNull("value"))values.remove(key);else values.put(key,call.getData().getString("value"));NativeIO.json(file,values);return null;});}
 @PluginMethod public void inboxPending(PluginCall call){perform(call,s->new JSONObject().put("deliveries",s.shares.pending(call.getBoolean("includeIgnored",false))));}
 @PluginMethod public void inboxDismiss(PluginCall call){perform(call,s->{s.shares.dismiss(NativeIO.required(call.getData(),"deliveryId"),NativeIO.required(call.getData(),"accountId"));return null;});}
 @PluginMethod public void inboxRestore(PluginCall call){perform(call,s->{s.shares.restore(NativeIO.required(call.getData(),"deliveryId"),NativeIO.required(call.getData(),"accountId"));return null;});}
 @PluginMethod public void inboxClaim(PluginCall call){perform(call,s->new JSONObject().put("accountId",s.shares.claim(NativeIO.required(call.getData(),"deliveryId"),NativeIO.required(call.getData(),"accountId"))));}
 @PluginMethod public void inboxAcknowledge(PluginCall call){perform(call,s->{s.shares.acknowledge(NativeIO.required(call.getData(),"deliveryId"),NativeIO.required(call.getData(),"accountId"));return null;});}
 @PluginMethod public void filePick(PluginCall call){Intent intent=new Intent(Intent.ACTION_OPEN_DOCUMENT).setType("*/*").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_ALLOW_MULTIPLE,true).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);startActivityForResult(call,intent,"picked");}
 @ActivityCallback private void picked(PluginCall call,ActivityResult result){if(call==null)return;if(result.getResultCode()!=Activity.RESULT_OK||result.getData()==null){call.resolve(new JSObject().put("files",new JSArray()));return;}Intent intent=result.getData();perform(call,s->{LinkedHashSet<Uri> uris=new LinkedHashSet<>();if(intent.getData()!=null)uris.add(intent.getData());if(intent.getClipData()!=null)for(int i=0;i<intent.getClipData().getItemCount();i++)uris.add(intent.getClipData().getItemAt(i).getUri());if(uris.size()>100)throw new IOException("TOO_MANY_FILES");JSONArray refs=new JSONArray();for(Uri uri:uris)refs.put(s.files.copyUri(uri));return new JSONObject().put("files",refs);});}
 @PluginMethod public void fileRead(PluginCall call){perform(call,s->new JSONObject().put("data",Base64.encodeToString(s.files.source(NativeIO.required(call.getData(),"token"),call.getData().getLong("offset"),call.getData().getInt("length")),Base64.NO_WRAP)));}
 @PluginMethod public void storageRead(PluginCall call){perform(call,s->s.files.readStorage(NativeIO.required(call.getData(),"accountId"),NativeIO.required(call.getData(),"key"),call.getData().has("offset")?call.getData().getLong("offset"):null,call.getData().has("length")?call.getData().getInt("length"):null));}
 @PluginMethod public void storageSize(PluginCall call){perform(call,s->{File file=s.files.file(NativeIO.required(call.getData(),"accountId"),NativeIO.required(call.getData(),"key"));return new JSONObject().put("size",file.exists()?file.length():JSONObject.NULL);});}
 @PluginMethod public void storageWrite(PluginCall call){perform(call,s->{s.files.write(NativeIO.required(call.getData(),"accountId"),NativeIO.required(call.getData(),"key"),call.getData().getString("data"));return null;});}
 @PluginMethod public void storageRemove(PluginCall call){perform(call,s->{new android.util.AtomicFile(s.files.file(NativeIO.required(call.getData(),"accountId"),NativeIO.required(call.getData(),"key"))).delete();return null;});}
 @PluginMethod public void filePreview(PluginCall call){perform(call,s->s.files.preview(NativeIO.required(call.getData(),"accountId"),call.getData().getJSONArray("keys"),call.getData().getLong("size"),NativeIO.required(call.getData(),"mime")));}
 @PluginMethod public void fileReleasePreview(PluginCall call){perform(call,s->{s.files.release(NativeIO.required(call.getData(),"token"));return null;});}
 @PluginMethod public void captureInput(PluginCall call) {
  perform(call, s -> {
   String account = NativeIO.required(call.getData(), "accountId"), id = NativeIO.required(call.getData(), "id");
   if (account.length() > 100 || !id.matches("[a-f0-9-]{36}")) throw new SecurityException("INVALID_CAPTURE_INPUT");
   String key = "paste:" + account + ":" + id;
   NativeShareInputs inputs = new NativeShareInputs(getContext(), s.credentials);
   String operation = NativeIO.required(call.getData(), "operation"), value = null;
   if ("get".equals(operation)) value = inputs.pasted(key);
   else if ("remove".equals(operation)) inputs.remove(key);
   else if ("put".equals(operation)) {
    String raw = NativeIO.required(call.getData(), "raw");
    if (raw.length() > 16384) throw new SecurityException("INVALID_CAPTURE_INPUT");
    inputs.protectRaw(key, raw, call.getData().getLong("expiresAt"));
   } else throw new SecurityException("INVALID_CAPTURE_INPUT");
   return new JSONObject().put("value", value == null ? JSONObject.NULL : value);
  });
 }
 @PluginMethod public void filePrepareExport(PluginCall call) {
  perform(call, s -> s.files.prepareExport(NativeIO.required(call.getData(), "accountId"), call.getData().getJSONArray("keys"), call.getData().getLong("size"), NativeIO.required(call.getData(), "mime")));
 }
 @PluginMethod public void fileReleaseExport(PluginCall call) {
  // Revoke immediately, including while the serial worker is streaming.
  try {NativeServices.get(getContext()).files.releaseExport(NativeIO.required(call.getData(), "token")); call.resolve();}
  catch (Exception error) {call.reject("EXPORT_REVOKED", "EXPORT_REVOKED");}
 }
 @PluginMethod public void fileExport(PluginCall call) {
  String name = call.getString("name", "资料").replaceAll("[\\\\/\\p{Cntrl}]", "_");
  String mime = call.getString("mime", "application/octet-stream");
  if (!mime.matches("[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+")) {call.reject("INVALID_EXPORT", "INVALID_EXPORT"); return;}
  Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT).setType(mime).addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE, name.substring(0, Math.min(240, name.length())));
  startActivityForResult(call, intent, "fileExportTarget");
 }
 @ActivityCallback private void fileExportTarget(PluginCall call, ActivityResult result) {
  if (call == null) return;
  if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {call.reject("已取消导出", "CANCELLED"); return;}
  Uri uri = result.getData().getData();
  perform(call, s -> {s.files.export(NativeIO.required(call.getData(), "token"), uri); return null;});
 }
 @PluginMethod public void fileSaveBackup(PluginCall call){Intent intent=new Intent(Intent.ACTION_CREATE_DOCUMENT).setType("application/json").addCategory(Intent.CATEGORY_OPENABLE).putExtra(Intent.EXTRA_TITLE,call.getString("name","workbench-backup.json"));startActivityForResult(call,intent,"backupTarget");}
 @ActivityCallback private void backupTarget(PluginCall call,ActivityResult result){if(call==null)return;if(result.getResultCode()!=Activity.RESULT_OK||result.getData()==null||result.getData().getData()==null){call.reject("已取消导出","CANCELLED");return;}Uri uri=result.getData().getData();perform(call,s->{try(OutputStream output=getContext().getContentResolver().openOutputStream(uri,"wt")){if(output==null)throw new IOException("EXPORT_UNAVAILABLE");output.write(Base64.decode(call.getData().getString("data"),Base64.NO_WRAP));}return null;});}
 @PluginMethod public void notificationCapabilities(PluginCall call){perform(call,s->s.notifications.capabilities());}
 @PluginMethod public void notificationRequest(PluginCall call){if(Build.VERSION.SDK_INT<33){perform(call,s->s.notifications.capabilities());return;}getContext().getSharedPreferences("native-device",Context.MODE_PRIVATE).edit().putBoolean("notification-requested",true).apply();requestPermissionForAlias("notifications",call,"notificationPermission");}
 @PermissionCallback private void notificationPermission(PluginCall call){perform(call,s->{s.notifications.restore();return s.notifications.capabilities();});}
 @PluginMethod public void notificationExactSettings(PluginCall call){if(Build.VERSION.SDK_INT>=31)getActivity().startActivity(new Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM,Uri.parse("package:"+getContext().getPackageName())));call.resolve();}
 @PluginMethod public void notificationReconcile(PluginCall call){perform(call,s->{s.notifications.reconcile(NativeIO.required(call.getData(),"accountId"),call.getData().getJSONArray("reminders"),call.getString("horizonUntil"));return null;});}
}
