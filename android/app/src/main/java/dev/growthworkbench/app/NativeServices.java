package dev.growthworkbench.app;
import android.content.Context;
final class NativeServices {
 private static volatile NativeServices instance;
 final NativeCredentials credentials;final NativeFiles files;final NativeShares shares;final NativeRepository repository;final NativeNotifications notifications;
 private NativeServices(Context context) throws Exception {Context app=context.getApplicationContext();credentials=new NativeCredentials(app);files=new NativeFiles(app);shares=new NativeShares(app,files,credentials);repository=new NativeRepository(app,credentials);notifications=new NativeNotifications(app);}
 static synchronized NativeServices get(Context context) throws Exception {if(instance==null)instance=new NativeServices(context);return instance;}
 static NativeServices peek(){return instance;}
}
