package dev.growthworkbench.app;
import android.content.*;
/** System broadcasts restore the persisted horizon without WebView or network. */
public final class ReminderReceiver extends BroadcastReceiver {
 @Override public void onReceive(Context context,Intent intent){PendingResult pending=goAsync();NativeIO.SERIAL.execute(()->{try{NativeNotifications notifications=NativeServices.get(context).notifications;if("dev.growthworkbench.REMIND".equals(intent.getAction()))notifications.deliver(intent);else notifications.restore();}catch(Exception ignored){/* Foreground capability/status check will expose denial; never log private titles. */}finally{pending.finish();}});}
}
