export interface RecoveryWrites {
 checkpointBackupStarted:boolean; auditWriteStarted:boolean; temporaryCheckpointStarted:boolean; lockCreated:boolean; lockReleased:boolean; backupDirectoryCreated:boolean; checkpointBackupComplete:boolean;
 sqliteBackupStarted:boolean; sqliteBackupComplete:boolean; auditWritten:boolean; temporaryCheckpointWritten:boolean; checkpointReplaced:boolean;
 ticketBodiesWritten:false;
}
export const emptyWrites=():RecoveryWrites=>({checkpointBackupStarted:false,auditWriteStarted:false,temporaryCheckpointStarted:false,lockCreated:false,lockReleased:false,backupDirectoryCreated:false,checkpointBackupComplete:false,sqliteBackupStarted:false,sqliteBackupComplete:false,auditWritten:false,temporaryCheckpointWritten:false,checkpointReplaced:false,ticketBodiesWritten:false});
export function sanitizedCause(error:unknown):{code:string;errorType:string;sqliteCode?:number;sqliteReason?:string;integrationReason?:string}{
 const e=error as {code?:unknown;errcode?:unknown;errstr?:unknown;name?:unknown;diagnostic?:{reason?:unknown}}|null;
 const allowed=new Set(['ENOENT','EACCES','EPERM','EEXIST','ENOSPC','ENOTDIR','EISDIR','EMFILE','EBUSY','EIO','ERR_SQLITE_ERROR','ERR_INVALID_ARG_TYPE','ERR_OUT_OF_RANGE','ECONNREFUSED','EHOSTUNREACH','ENETUNREACH']);
 const sqliteCode=typeof e?.errcode==='number'&&Number.isSafeInteger(e.errcode)?e.errcode:undefined;
 const sqliteReason=sqliteCode===undefined?({'attempt to write a readonly database':'readonly','database is locked':'busy','database table is locked':'locked','unable to open database file':'cannot_open','database or disk is full':'disk_full','database disk image is malformed':'corrupt','SQL logic error':'sql_error'} as Record<string,string>)[typeof e?.errstr==='string'?e.errstr:'']:({1:'sql_error',5:'busy',6:'locked',8:'readonly',10:'io_error',11:'corrupt',13:'disk_full',14:'cannot_open',19:'constraint',26:'not_database'} as Record<number,string>)[sqliteCode&255]||'other';
 const integrationReason=['invalid_event_body','entity_conversion','ambiguous_timestamp','invalid_timestamp','missing_timestamp'].includes(String(e?.diagnostic?.reason))?String(e?.diagnostic?.reason):undefined;
 return {...(integrationReason?{integrationReason}:{}),code:typeof e?.code==='string'&&allowed.has(e.code)?e.code:'UNCLASSIFIED',...(sqliteCode===undefined?(sqliteReason?{sqliteReason}:{}):{sqliteCode,sqliteReason}),errorType:['Error','TypeError','RangeError','SyntaxError','OperationError'].includes(String(e?.name))?String(e?.name):'Error'};
}
export class RecoveryAbort extends Error {
 constructor(public diagnostic:{status:'aborted';stage:string;reason:string;writes:RecoveryWrites;cause?:ReturnType<typeof sanitizedCause>;backup?:string;auditId?:string;cleanupIssue?:string}){super(diagnostic.reason);}
}
export function reportRecoveryError(error:unknown){
 return error instanceof RecoveryAbort?error.diagnostic:{status:'aborted',stage:'cli.unknown',reason:'Unexpected failure; raw exception omitted',writes:emptyWrites(),cause:sanitizedCause(error)};
}
