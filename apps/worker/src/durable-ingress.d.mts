import type {ChannelModel} from 'amqplib';
import type {PackageConfig} from './config.js';
import type {ConnectionState} from '@lsports/contracts';
export function connectDurableMq(pkg:PackageConfig,path:string,onMetrics?:(metrics:NonNullable<ConnectionState['ingressProgress']>&{ingressActorId?:string})=>void,options?:{offline?:boolean;maxBytes?:number;sessionId?:string}):Promise<ChannelModel & {quiesce():void;intakePaused():boolean;crashOfflineForTest():Promise<void>;offline(messages:any[]):void;offlineLoad(config:any):Promise<{sent:number;durationMs:number}>;recoveryAnchor():number|undefined;checkpointAnchor(seconds:number):Promise<boolean>}>;
export function openInbox(path:string,maxBytes?:number):{append(messages:any[]):number[];peek(limit?:number,after?:number):any[];complete(ids:number[]):void;safePoint(seconds:number,checkpointPrefix?:boolean):number;safeSeconds():number|undefined;processingStats(after:number):{processingBacklog:number;oldestProcessingAgeMs:number};stats():{backlog:number;bytes:number;oldestAgeMs:number;databaseBytes:number;walBytes:number};close():void};

export function ingressFailureDetails(error:unknown,stage:string):{ingressStage:string;errorType:string;errorCode:string|number|null;sqliteErrcode:number|null;signals:string[];stackFrames:{file:string;line:number;column:number|null}[]};

export function persistIngressBatch(inbox:{append(messages:any[]):unknown},batch:any[],acknowledge:(message:any)=>void,options?:{canAcknowledge?:()=>boolean;onCommitted?:(ms:number)=>void;onAcknowledged?:()=>void;onAckFailure?:(error:unknown)=>void}):{committedRows:number;acknowledged:number};
export function isClosedIngressChannel(error:unknown):boolean;
