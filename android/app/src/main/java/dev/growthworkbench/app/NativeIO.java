package dev.growthworkbench.app;

import android.content.Context;
import android.util.AtomicFile;
import org.json.JSONObject;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class NativeIO {
 static final ExecutorService SERIAL = Executors.newSingleThreadExecutor();
 static String hash(String value) throws Exception {byte[] digest=MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));StringBuilder out=new StringBuilder();for(byte b:digest)out.append(String.format("%02x",b&255));return out.toString();}
 static File directory(Context context,String name) throws IOException {File directory=new File(context.getNoBackupFilesDir(),name);if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("PRIVATE_STORAGE_UNAVAILABLE");return directory;}
 static void atomic(File file,byte[] bytes) throws IOException {AtomicFile atomic=new AtomicFile(file);FileOutputStream output=null;try{output=atomic.startWrite();output.write(bytes);atomic.finishWrite(output);}catch(IOException error){if(output!=null)atomic.failWrite(output);throw error;}}
 static boolean exists(File file){return file.exists()||new File(file.getPath()+".bak").exists();}
 static File recover(File file) throws IOException {if(new File(file.getPath()+".bak").exists())try(InputStream ignored=new AtomicFile(file).openRead()){}return file;}
 static JSONObject json(File file) throws Exception {if(!exists(file))return new JSONObject();try(InputStream stream=new AtomicFile(file).openRead()){ByteArrayOutputStream bytes=new ByteArrayOutputStream();byte[] chunk=new byte[8192];int n;while((n=stream.read(chunk))!=-1)bytes.write(chunk,0,n);return new JSONObject(new String(bytes.toByteArray(),StandardCharsets.UTF_8));}}
 static void json(File file,JSONObject value) throws IOException {atomic(file,value.toString().getBytes(StandardCharsets.UTF_8));}
 static String required(JSONObject input,String key) throws Exception {String value=input.getString(key);if(value.isEmpty()||value.length()>4096)throw new IOException("INVALID_INPUT");return value;}
}
