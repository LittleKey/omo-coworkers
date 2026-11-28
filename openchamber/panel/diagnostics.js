const stages=new Set(["save-click","action-begin","preview-send","request-send","service-response","request-error","preview-ready","commit-send","commit-response","readback"])
const paths=new Set(["/workbench","/models","/models?refresh=true","/workbench/context","/workbench/draft","/workbench/import-native","/workbench/preview","/workbench/operations"])
const methods=new Set(["GET","POST","PATCH"])
const codes=new Set(["HOST_TIMEOUT","HOST_REJECTED","SERVICE_UNAVAILABLE","INVALID_REQUEST","INVALID_ROUTE","CONFLICT","INVALID_CONFIG","MISSING_TRANSPORT","PROTECTED_FIELD","PREVIEW_EXPIRED","REQUEST_FAILED"])
// Memory only: no arbitrary caller text, persistence, telemetry or automatic copy.
export function createDiagnostics(onChange=()=>{}){
  const events=[];let sequence=0,requests=0
  const start=performance.now()
  const add=(stage,metadata={})=>{
    if(!stages.has(stage))return
    const event={sequence:++sequence,timestamp:new Date().toISOString(),elapsedMs:Math.round(performance.now()-start),stage}
    if(methods.has(metadata.method))event.method=metadata.method
    if(paths.has(metadata.path))event.path=metadata.path
    if(Number.isSafeInteger(metadata.request)&&metadata.request>0)event.request=metadata.request
    if(["absent","string","unexpected-non-string"].includes(metadata.bodyType))event.bodyType=metadata.bodyType
    if(Number.isSafeInteger(metadata.byteCount)&&metadata.byteCount>=0)event.byteCount=metadata.byteCount
    if(Number.isInteger(metadata.status)&&metadata.status>=100&&metadata.status<=599)event.status=metadata.status
    if(metadata.errorCode!==undefined)event.errorCode=codes.has(metadata.errorCode)?metadata.errorCode:"UNKNOWN"
    events.push(event);if(events.length>100)events.shift()
    try{onChange()}catch{}
  }
  return {
    add,
    export:()=>JSON.stringify(events,null,2),
    clear:()=>{events.length=0;try{onChange()}catch{}},
    async serviceRequest(host,input){
      const meta={request:++requests,method:input.method,path:input.path,bodyType:input.body===undefined?"absent":typeof input.body==="string"?"string":"unexpected-non-string"}
      // Observe actual helper output at SDK input, without serializing it again.
      if(typeof input.body==="string")meta.byteCount=new TextEncoder().encode(input.body).byteLength
      add("request-send",meta)
      try{const result=await host.serviceRequest(input);add("service-response",{...meta,status:result.status});return result}
      catch(error){add("request-error",{...meta,errorCode:error?.code??"UNKNOWN"});throw error}
    },
  }
}
