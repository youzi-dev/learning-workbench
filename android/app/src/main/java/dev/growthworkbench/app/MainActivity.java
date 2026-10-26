package dev.growthworkbench.app;

import android.content.Intent;
import android.os.Bundle;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.BridgeWebViewClient;
import java.util.UUID;
import android.widget.Toast;

public class MainActivity extends BridgeActivity {
 private String deliveryId;
 @Override public void onCreate(Bundle savedInstanceState){registerPlugin(ShareInboxPlugin.class);super.onCreate(savedInstanceState);getBridge().getWebView().setWebViewClient(new BridgeWebViewClient(getBridge()){@Override public WebResourceResponse shouldInterceptRequest(android.webkit.WebView view,WebResourceRequest request){NativeServices services=NativeServices.peek();WebResourceResponse response=services==null?null:services.files.intercept(request);return response!=null?response:super.shouldInterceptRequest(view,request);}});accept(getIntent(),savedInstanceState==null?null:savedInstanceState.getString("workbench-delivery"));}
 @Override protected void onNewIntent(Intent intent){super.onNewIntent(intent);setIntent(intent);accept(intent,null);}
 private void accept(Intent incoming,String restored){if(incoming==null||(!Intent.ACTION_SEND.equals(incoming.getAction())&&!Intent.ACTION_SEND_MULTIPLE.equals(incoming.getAction())))return;deliveryId=deliveryIdentity(restored);final String id=deliveryId;final Intent original=new Intent(incoming);NativeIO.SERIAL.execute(()->{boolean success=true;try{NativeServices.get(this).shares.receive(original,id);}catch(Exception ignored){success=false;}final boolean failed=!success;runOnUiThread(()->{if(failed)Toast.makeText(this,"分享未保存，请保留原文件并重新分享",Toast.LENGTH_LONG).show();com.getcapacitor.PluginHandle handle=getBridge().getPlugin("ShareInbox");if(handle!=null)((ShareInboxPlugin)handle.getInstance()).inboxChanged();});});}
 /** External senders cannot choose a delivery identity; only system-restored state may retain it. */
 static String deliveryIdentity(String restored){return restored!=null&&restored.matches("[a-f0-9-]{36}")?restored:UUID.randomUUID().toString();}
 @Override public void onSaveInstanceState(Bundle state){if(deliveryId!=null)state.putString("workbench-delivery",deliveryId);super.onSaveInstanceState(state);}
}
