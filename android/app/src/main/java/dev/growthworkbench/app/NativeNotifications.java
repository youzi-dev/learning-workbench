package dev.growthworkbench.app;

import android.Manifest;
import android.app.*;
import android.content.*;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import androidx.core.app.NotificationManagerCompat;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.File;
import java.time.Instant;

/** Durable desired snapshot is the fence checked again by every alarm delivery. */
final class NativeNotifications {
 static final String CHANNEL="workbench-calendar-v2";
 private final Context context;private final File state;private final AlarmManager alarms;private final NotificationManager manager;
 NativeNotifications(Context context) throws Exception {this.context=context;state=new File(NativeIO.directory(context,"notifications-v2"),"desired.json");alarms=(AlarmManager)context.getSystemService(Context.ALARM_SERVICE);manager=(NotificationManager)context.getSystemService(Context.NOTIFICATION_SERVICE);manager.createNotificationChannel(new NotificationChannel(CHANNEL,"日程提醒",NotificationManager.IMPORTANCE_DEFAULT));}
 JSONObject capabilities() throws Exception {boolean granted=NotificationManagerCompat.from(context).areNotificationsEnabled()&&(Build.VERSION.SDK_INT<33||context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)==PackageManager.PERMISSION_GRANTED);NotificationChannel channel=manager.getNotificationChannel(CHANNEL);granted=granted&&(channel==null||channel.getImportance()!=NotificationManager.IMPORTANCE_NONE);JSONObject desired=NativeIO.json(state);boolean requested=context.getSharedPreferences("native-device",Context.MODE_PRIVATE).getBoolean("notification-requested",false);String permission=granted?"granted":Build.VERSION.SDK_INT>=33&&!requested&&context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)!=PackageManager.PERMISSION_GRANTED?"prompt":"denied";boolean exact=Build.VERSION.SDK_INT<31||alarms.canScheduleExactAlarms();return new JSONObject().put("permission",permission).put("exact",exact).put("horizonUntil",desired.optString("horizonUntil","")).put("message",!granted?"通知许可未开启，日程仍保存在本机":!exact?"精确定时未开启，提醒可能延迟；可在系统设置授权":"仅提醒已在本机的未来 30 天日程；厂商省电、强行停止和隐私空间可能阻止提醒");}
 private PendingIntent alarm(String account,long generation,JSONObject reminder) throws Exception {Intent intent=new Intent(context,ReminderReceiver.class).setAction("dev.growthworkbench.REMIND").setData(Uri.parse("workbench://reminder/"+NativeIO.hash(account+":"+reminder.getString("id"))+"/"+generation)).putExtra("accountId",account).putExtra("generation",generation).putExtra("reminderId",reminder.getString("id"));return PendingIntent.getBroadcast(context,0,intent,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);}
 private String tag(String account,JSONObject reminder) throws Exception {return NativeIO.hash(account+":"+reminder.getString("id"));}
 private void cancel(JSONObject previous) throws Exception {String account=previous.optString("accountId","");long generation=previous.optLong("generation",0);JSONArray reminders=previous.optJSONArray("reminders");if(reminders==null)return;for(int i=0;i<reminders.length();i++){JSONObject reminder=reminders.getJSONObject(i);PendingIntent pending=alarm(account,generation,reminder);alarms.cancel(pending);pending.cancel();manager.cancel(tag(account,reminder),0);}}
 void reconcile(String account,JSONArray reminders,String horizon) throws Exception {
  if(reminders.length()>10000)throw new IllegalArgumentException("TOO_MANY_REMINDERS");for(int i=0;i<reminders.length();i++){JSONObject reminder=reminders.getJSONObject(i);NativeIO.required(reminder,"id");NativeIO.required(reminder,"title");Instant.parse(reminder.getString("fireAt"));}
  JSONObject previous=NativeIO.json(state);JSONObject next=new JSONObject().put("accountId",account).put("generation",previous.optLong("generation",0)+1).put("horizonUntil",horizon==null?"":horizon).put("reminders",reminders);
  NativeIO.json(state,next);cancel(previous);schedule(next);
 }
 private void schedule(JSONObject desired) throws Exception {if(!"granted".equals(capabilities().getString("permission")))return;JSONArray reminders=desired.optJSONArray("reminders");if(reminders==null)return;String account=desired.getString("accountId");long generation=desired.getLong("generation"),now=System.currentTimeMillis();for(int i=0;i<reminders.length();i++){JSONObject reminder=reminders.getJSONObject(i);long fire=Instant.parse(reminder.getString("fireAt")).toEpochMilli();if(fire<=now)continue;PendingIntent pending=alarm(account,generation,reminder);if(Build.VERSION.SDK_INT<31||alarms.canScheduleExactAlarms()){try{alarms.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,fire,pending);}catch(SecurityException denied){alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,fire,pending);}}else alarms.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP,fire,pending);}}
 void restore() throws Exception {schedule(NativeIO.json(state));}
 void deliver(Intent intent) throws Exception {JSONObject desired=NativeIO.json(state);if(!intent.getStringExtra("accountId").equals(desired.optString("accountId"))||intent.getLongExtra("generation",-1)!=desired.optLong("generation",0)||!"granted".equals(capabilities().getString("permission")))return;JSONArray reminders=desired.optJSONArray("reminders");if(reminders==null)return;for(int i=0;i<reminders.length();i++){JSONObject reminder=reminders.getJSONObject(i);if(!reminder.getString("id").equals(intent.getStringExtra("reminderId")))continue;Intent open=new Intent(context,MainActivity.class).setAction(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER).setFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_SINGLE_TOP);PendingIntent activity=PendingIntent.getActivity(context,0,open,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);Notification notification=new Notification.Builder(context,CHANNEL).setSmallIcon(android.R.drawable.ic_dialog_info).setContentTitle(reminder.getString("title")).setContentText("日常工作台 · 已同步到本机的日程").setContentIntent(activity).setAutoCancel(true).setVisibility(Notification.VISIBILITY_PRIVATE).build();manager.notify(tag(desired.getString("accountId"),reminder),0,notification);return;}}
}
