package dev.growthworkbench.app;

import android.content.Context;
import android.database.Cursor;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.util.Base64;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import org.json.JSONArray;
import org.json.JSONObject;
import java.io.*;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;

/** Logical storage keys are hashed; no caller can request an arbitrary native path. */
final class NativeFiles {
 static final int PART=1048576;static final long LIMIT=1073741824L;
 private final Context context;private final File sources,storage;private final Map<String,Preview> previews=new ConcurrentHashMap<>();
 private final Map<String,Preview> exports=new ConcurrentHashMap<>();
 private static final class Preview {final List<File> files;final long size;final String mime;Preview(List<File> files,long size,String mime){this.files=files;this.size=size;this.mime=mime;}}
 NativeFiles(Context context) throws Exception {this.context=context;sources=NativeIO.directory(context,"share-originals-v2");storage=NativeIO.directory(context,"resources-v2");}
 JSONObject copyUri(Uri uri) throws Exception {
  String token=UUID.randomUUID().toString(),name="分享文件",mime=context.getContentResolver().getType(uri);if(mime==null||mime.isEmpty())mime="application/octet-stream";
  try(Cursor cursor=context.getContentResolver().query(uri,new String[]{OpenableColumns.DISPLAY_NAME},null,null,null)){if(cursor!=null&&cursor.moveToFirst()&&!cursor.isNull(0))name=cursor.getString(0);}name=name.replaceAll("[\\\\/\\p{Cntrl}]","_");if(name.isEmpty())name="分享文件";if(name.length()>240)name=name.substring(0,240);
  File partial=new File(sources,token+".partial"),file=new File(sources,token+".bin");long count=0;
  try(InputStream input=context.getContentResolver().openInputStream(uri);FileOutputStream output=new FileOutputStream(partial)){if(input==null)throw new IOException("URI_UNAVAILABLE");byte[] chunk=new byte[65536];int n;while((n=input.read(chunk))!=-1){count+=n;if(count>LIMIT)throw new IOException("FILE_TOO_LARGE");output.write(chunk,0,n);}output.getFD().sync();}catch(Exception error){partial.delete();throw error;}
  if(!partial.renameTo(file)){partial.delete();throw new IOException("PRIVATE_COPY_FAILED");}
  JSONObject ref=new JSONObject().put("token","native:"+token).put("name",name).put("mime",mime).put("size",count);NativeIO.json(new File(sources,token+".json"),ref);return ref;
 }
 byte[] source(String token,long offset,int length) throws Exception {if(!token.matches("native:[a-f0-9-]{36}"))throw new IOException("INVALID_SOURCE_TOKEN");return read(new File(sources,token.substring(7)+".bin"),offset,length);}
 File file(String account,String key) throws Exception {File directory=new File(storage,NativeIO.hash(account));if(!directory.isDirectory()&&!directory.mkdirs())throw new IOException("PRIVATE_STORAGE_UNAVAILABLE");return NativeIO.recover(new File(directory,NativeIO.hash(key)+".bin"));}
 static byte[] read(File file,long offset,int length) throws Exception {if(offset<0||length<0||length>PART||offset+length>file.length())throw new IOException("INVALID_FILE_RANGE");byte[] bytes=new byte[length];try(RandomAccessFile stream=new RandomAccessFile(file,"r")){stream.seek(offset);stream.readFully(bytes);}return bytes;}
 JSONObject readStorage(String account,String key,Long offset,Integer length) throws Exception {File file=file(account,key);if(!file.exists())return new JSONObject().put("data",JSONObject.NULL);long from=offset==null?0:offset;int count=length==null?Math.toIntExact(file.length()):length;return new JSONObject().put("data",Base64.encodeToString(read(file,from,count),Base64.NO_WRAP));}
 void write(String account,String key,String data) throws Exception {byte[] bytes=Base64.decode(data,Base64.NO_WRAP);if(bytes.length>PART)throw new IOException("FILE_PART_TOO_LARGE");NativeIO.atomic(file(account,key),bytes);}
 JSONObject preview(String account,JSONArray keys,long size,String mime) throws Exception {if(!Arrays.asList("application/pdf","image/png","image/jpeg","image/gif","image/webp","image/avif","video/mp4","video/webm","video/ogg","video/quicktime").contains(mime))throw new SecurityException("UNSUPPORTED_PREVIEW_TYPE");if(size<0||size>LIMIT||keys.length()>2048)throw new IOException("INVALID_PREVIEW");List<File> parts=new ArrayList<>();long actual=0;for(int i=0;i<keys.length();i++){File part=file(account,keys.getString(i));if(!part.isFile())throw new IOException("PREVIEW_MISSING");parts.add(part);actual+=part.length();}if(actual!=size)throw new IOException("PREVIEW_SIZE_MISMATCH");String token=UUID.randomUUID().toString();previews.put(token,new Preview(parts,size,mime));return new JSONObject().put("token",token).put("url","https://localhost/_wb_preview/"+token);}
 JSONObject prepareExport(String account, JSONArray keys, long size, String mime) throws Exception {
  if (size < 0 || size > LIMIT || keys.length() > 2048 || !mime.matches("[a-zA-Z0-9!#$&^_.+-]+/[a-zA-Z0-9!#$&^_.+-]+")) throw new IOException("INVALID_EXPORT");
  List<File> parts = new ArrayList<>();
  long actual = 0;
  for (int i = 0; i < keys.length(); i++) {
   String key = keys.getString(i);
   if (!key.startsWith("stage:") && !key.startsWith("cache/")) throw new IOException("INVALID_EXPORT_KEY");
   File part = file(account, key);
   if (!part.isFile() || part.length() > PART) throw new IOException("EXPORT_MISSING");
   parts.add(part); actual += part.length();
  }
  if (actual != size) throw new IOException("EXPORT_SIZE_MISMATCH");
  String token = UUID.randomUUID().toString();
  exports.put(token, new Preview(parts, size, mime));
  return new JSONObject().put("token", token);
 }
 void releaseExport(String token) {exports.remove(token);}
 void export(String token, Uri target) throws Exception {
  Preview source = exports.get(token);
  if (source == null || !"content".equals(target.getScheme())) throw new IOException("EXPORT_REVOKED");
  try (InputStream input = new PartsInput(source.files, 0, source.size);
       OutputStream output = context.getContentResolver().openOutputStream(target, "wt")) {
   if (output == null) throw new IOException("EXPORT_UNAVAILABLE");
   byte[] buffer = new byte[65536];
   int count;
   while ((count = input.read(buffer)) != -1) {
    if (!exports.containsKey(token)) throw new IOException("EXPORT_REVOKED");
    output.write(buffer, 0, count);
   }
  } finally {exports.remove(token);}
 }
 void release(String token){previews.remove(token);}
 WebResourceResponse intercept(WebResourceRequest request){String path=request.getUrl().getPath();if(!"localhost".equals(request.getUrl().getHost())||path==null||!path.startsWith("/_wb_preview/"))return null;Preview preview=previews.get(path.substring("/_wb_preview/".length()));if(preview==null)return response("text/plain",404,"Not Found",Collections.emptyMap(),new ByteArrayInputStream(new byte[0]));try{long start=0,end=preview.size-1;String range=null;for(Map.Entry<String,String> header:request.getRequestHeaders().entrySet())if("range".equalsIgnoreCase(header.getKey()))range=header.getValue();boolean partial=range!=null;
  if(partial){if(!range.matches("bytes=\\d*-\\d*"))throw new IOException("INVALID_RANGE");String[] values=range.substring(6).split("-",-1);if(values[0].isEmpty()){long suffix=Long.parseLong(values[1]);if(suffix<=0)throw new IOException("INVALID_RANGE");start=Math.max(0,preview.size-suffix);}else{start=Long.parseLong(values[0]);if(!values[1].isEmpty())end=Math.min(end,Long.parseLong(values[1]));}if(start<0||start>=preview.size||end<start)throw new IOException("INVALID_RANGE");}
  long length=preview.size==0?0:end-start+1;Map<String,String> headers=new HashMap<>();headers.put("Accept-Ranges","bytes");headers.put("Content-Length",Long.toString(length));headers.put("Cache-Control","no-store");headers.put("X-Content-Type-Options","nosniff");if(partial)headers.put("Content-Range","bytes "+start+"-"+end+"/"+preview.size);
  return response(preview.mime,partial?206:200,partial?"Partial Content":"OK",headers,new PartsInput(preview.files,start,length));
 }catch(Exception error){return response("text/plain",416,"Range Not Satisfiable",Collections.singletonMap("Content-Range","bytes */"+preview.size),new ByteArrayInputStream(new byte[0]));}}
 private WebResourceResponse response(String mime,int code,String reason,Map<String,String> headers,InputStream stream){return new WebResourceResponse(mime,null,code,reason,headers,stream);}
 /** Reads across bounded durable parts without assembling a whole video in either process. */
 private static final class PartsInput extends InputStream {private final List<File> files;private int index;private long offset,remaining;private RandomAccessFile stream;PartsInput(List<File> files,long offset,long remaining){this.files=files;this.offset=offset;this.remaining=remaining;}@Override public int read() throws IOException {byte[] one=new byte[1];return read(one,0,1)<0?-1:one[0]&255;}@Override public int read(byte[] bytes,int start,int length) throws IOException {if(length==0)return 0;if(remaining<=0)return -1;while(stream==null){if(index>=files.size())throw new EOFException();File file=files.get(index++);if(offset>=file.length()){offset-=file.length();continue;}stream=new RandomAccessFile(file,"r");stream.seek(offset);offset=0;}int n=stream.read(bytes,start,(int)Math.min(length,remaining));if(n<0){stream.close();stream=null;return read(bytes,start,length);}remaining-=n;return n;}@Override public void close() throws IOException {remaining=0;if(stream!=null)stream.close();}}
}
