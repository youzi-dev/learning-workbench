import React, {useEffect,useState} from 'react';
import type {ModuleContext} from '../../workbench/contracts/module';
import type {Entity} from '../../workbench/contracts/data';
import {readableLearningEntity} from './compatibility';
export function UnknownLearningRecords({context,signal}:{context:ModuleContext;signal:AbortSignal}) {
  const [records,setRecords]=useState<Entity[]>([]);
  useEffect(()=>{let current=true;const refresh=()=>{void context.repository.list('learning').then(all=>{if(current&&!signal.aborted)setRecords(all.filter(e=>!e.deletedAt&&!readableLearningEntity(e)));}).catch(()=>{});};refresh();const unsubscribe=context.subscribe(refresh);return()=>{current=false;unsubscribe();};},[context,signal]);
  return records.length?<aside className="wb-notice"><p>以下学习记录使用新的数据格式，原文已保留，当前只读。更新客户端后可继续编辑。</p>{records.map(record=><details key={record.id}><summary>{record.kind} · {record.id}</summary><pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{JSON.stringify(record,null,2)}</pre></details>)}</aside>:null;
}
