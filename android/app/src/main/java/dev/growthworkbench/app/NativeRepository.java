package dev.growthworkbench.app;

import android.content.Context;
import android.database.Cursor;
import net.zetetic.database.sqlcipher.SQLiteDatabase;
import org.json.JSONObject;
import org.json.JSONArray;
import java.io.File;
import java.util.*;
import java.security.SecureRandom;
import android.util.Base64;

/** All access occurs on NativeIO.SERIAL; callbacks never span connections or threads. */
final class NativeRepository {
 static final String[] TABLES={"entities","confirmed","outbox","conflicts","cursors","migrations","device_preferences"};
 private static final class Handle {final SQLiteDatabase database;final boolean readonly;long revision=0;Handle(SQLiteDatabase database,boolean readonly){this.database=database;this.readonly=readonly;}}
 private final Map<String,Handle> handles=new HashMap<>();private final Context context;private final NativeCredentials credentials;
 NativeRepository(Context context,NativeCredentials credentials){this.context=context;this.credentials=credentials;System.loadLibrary("sqlcipher");}
 JSONObject open(String accountId) throws Exception {
  String account=NativeIO.hash(accountId);File path=new File(NativeIO.directory(context,"workbench-v2"),"workbench-v2-"+account+".sqlite");
  String keyName="database-key:"+account;String secret=credentials.get(keyName);
  if(secret==null){if(path.exists())throw new SecurityException("REPAIR_DEVICE_REQUIRED");byte[] key=new byte[32];new SecureRandom().nextBytes(key);secret=Base64.encodeToString(key,Base64.NO_WRAP);credentials.set(keyName,secret);}
  byte[] password=secret.getBytes(java.nio.charset.StandardCharsets.UTF_8);
  SQLiteDatabase db;
  if(path.exists()){db=SQLiteDatabase.openDatabase(path.getAbsolutePath(),password,null,SQLiteDatabase.OPEN_READONLY,null);if(db.getVersion()<=2){db.close();db=SQLiteDatabase.openDatabase(path.getAbsolutePath(),password,null,SQLiteDatabase.OPEN_READWRITE,null);}}
  else db=SQLiteDatabase.openDatabase(path.getAbsolutePath(),password,null,SQLiteDatabase.OPEN_READWRITE|SQLiteDatabase.CREATE_IF_NECESSARY,null);
  try {
   int version=db.getVersion();boolean readonly=version>2;
   String engine=scalar(db,"SELECT sqlite_version()"),journal=scalar(db,"PRAGMA journal_mode");
   if(!"3.53.4".equals(engine))throw new IllegalStateException("UNSUPPORTED_SQLITE_VERSION");
   if(!readonly){journal=scalar(db,"PRAGMA journal_mode=WAL");if(!"wal".equalsIgnoreCase(journal))throw new IllegalStateException("WAL_UNAVAILABLE");db.execSQL("PRAGMA synchronous=FULL");scalar(db,"PRAGMA busy_timeout=5000");db.beginTransaction();try{for(String table:TABLES)db.execSQL("CREATE TABLE IF NOT EXISTS "+table+" (key TEXT PRIMARY KEY NOT NULL,value TEXT NOT NULL)");db.execSQL("CREATE TABLE IF NOT EXISTS _container (key TEXT PRIMARY KEY NOT NULL,value INTEGER NOT NULL)");db.execSQL("INSERT OR IGNORE INTO _container(key,value) VALUES('revision',0)");db.setVersion(2);db.setTransactionSuccessful();}finally{db.endTransaction();}}
   String handle=UUID.randomUUID().toString();handles.put(handle,new Handle(db,readonly));
   NativeIO.json(new File(NativeIO.directory(context,"workbench-v2"),"engine.json"),new JSONObject().put("engine","net.zetetic:sqlcipher-android:4.19.1").put("sqliteVersion",engine).put("journalMode",journal).put("walFix","SQLite 3.51.3 WAL reset fix; bundled SQLite 3.53.4"));
   return new JSONObject().put("handle",handle).put("readonly",readonly).put("sqliteVersion",engine).put("journalMode",journal);
  }catch(Exception error){db.close();throw error;}
 }
 private String scalar(SQLiteDatabase db,String sql){try(Cursor cursor=db.rawQuery(sql,new String[0])){if(!cursor.moveToFirst())throw new IllegalStateException("DATABASE_RESULT_MISSING");return cursor.getString(0);}}
 private Handle handle(String id){Handle found=handles.get(id);if(found==null)throw new IllegalStateException("REPOSITORY_CLOSED");return found;}
 private JSONObject state(Handle handle) throws Exception {JSONObject state=new JSONObject();Set<String> available=new HashSet<>();try(Cursor tables=handle.database.rawQuery("SELECT name FROM sqlite_master WHERE type='table'",new String[0])){while(tables.moveToNext())available.add(tables.getString(0));}for(String table:TABLES){JSONObject rows=new JSONObject();if(available.contains(table))try(Cursor cursor=handle.database.rawQuery("SELECT key,value FROM "+table,new String[0])){while(cursor.moveToNext())rows.put(cursor.getString(0),new org.json.JSONTokener(cursor.getString(1)).nextValue());}state.put(table,rows);}return state;}
 JSONObject snapshot(String id) throws Exception {Handle h=handle(id);h.database.execSQL("BEGIN");try{long revision=h.readonly?0:Long.parseLong(scalar(h.database,"SELECT value FROM _container WHERE key='revision'"));JSONObject result=new JSONObject().put("revision",revision).put("state",state(h));h.database.execSQL("COMMIT");return result;}catch(Exception error){h.database.execSQL("ROLLBACK");throw error;}}
 void commit(String id,long expected,JSONObject state) throws Exception {Handle h=handle(id);if(h.readonly)throw new IllegalStateException("READONLY_SCHEMA");h.database.beginTransaction();try{long current=Long.parseLong(scalar(h.database,"SELECT value FROM _container WHERE key='revision'"));if(current!=expected)throw new IllegalStateException("STALE_NATIVE_REVISION");if(state.length()!=TABLES.length)throw new IllegalArgumentException("INVALID_STATE");for(String table:TABLES){JSONObject rows=state.getJSONObject(table);h.database.execSQL("DELETE FROM "+table);Iterator<String> keys=rows.keys();while(keys.hasNext()){String key=keys.next();Object value=rows.get(key);String encoded=new JSONArray().put(value).toString();String json=encoded.substring(1,encoded.length()-1);h.database.execSQL("INSERT INTO "+table+"(key,value) VALUES(?,?)",new Object[]{key,json});}}h.database.execSQL("UPDATE _container SET value=? WHERE key='revision'",new Object[]{current+1});h.database.setTransactionSuccessful();}finally{h.database.endTransaction();}}
 void close(String id){Handle h=handles.remove(id);if(h!=null)h.database.close();}
}
