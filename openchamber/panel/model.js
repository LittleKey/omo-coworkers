export const VERSION = "7.1.2"
const routes = new Set(["GET /snapshot", "GET /models", "GET /contributions", "POST /intent-preview", "PATCH /config", "PATCH /settings", "POST /undo-preview", "POST /recover", "POST /migration-preview"])
export async function request(host, method, path, body) {
  if (!routes.has(`${method} ${path}`)) throw new Error("INVALID_ROUTE")
  const serializedBody = body === undefined ? undefined : JSON.stringify(body)
  if (serializedBody !== undefined && new TextEncoder().encode(serializedBody).length > 63000) throw new Error("请求过大")
  const result = await host.serviceRequest({method,path,...(serializedBody === undefined ? {} : {body:serializedBody})})
  let data
  try { data = typeof result.body === "string" ? JSON.parse(result.body) : result.body } catch {}
  if (result.status < 200 || result.status >= 300 || !data?.ok) {
    const error = new Error(data?.error?.reason || "无法读取本地服务")
    Object.assign(error,{code:data?.error?.code || "SERVICE_UNAVAILABLE",nextAction:data?.error?.nextAction || "请检查扩展服务授权后重试。",conflicts:data?.conflicts || []})
    throw error
  }
  return data
}
export function roleIntent(capability, draft, latest = capability) {
  const current = capability.settings, intent = {kind:"role-settings",capabilityId:capability.id}
  if (draft.enabled !== current.enabled) intent.enabled = draft.enabled
  if (draft.model !== current.model.value) {
    if (!current.model.editable || typeof draft.model !== "string" || !draft.model) throw new Error("当前模型来源不支持修改。")
    if (!current.variant.editable) throw new Error("思考等级来源不可修改，暂不能安全切换模型。")
    if (!draft.variantChosen) throw new Error("更换模型后，请明确选择思考等级或默认设置。")
    intent.model = draft.model; intent.variant = draft.variant
  } else if (draft.variantChosen && draft.variant !== current.variant.value) {
    if (!current.model.editable || !current.variant.editable) throw new Error("当前模型或思考等级来源不支持修改。")
    intent.variant = draft.variant
  }
  const now=latest?.settings
  if(!now)throw new Error("配置暂不可用；草稿保留。")
  const checked=new Set(Object.keys(intent).filter(k=>["enabled","model","variant"].includes(k)))
  // Model and variant form one dependent choice, even for a variant-only edit.
  if(checked.has("model")||checked.has("variant")){checked.add("model");checked.add("variant")}
  for(const key of checked){
    const before=key==="enabled"?current.enabled:current[key]
    const after=key==="enabled"?now.enabled:now[key]
    if(JSON.stringify(before)!==JSON.stringify(after)){
      const error=new Error(`外部已修改 ${key}；草稿保留，请取消修改后基于最新设置重新选择。`)
      error.code="CONFLICT";throw error
    }
  }
  return intent
}
export function hasChanges(capability,draft) {
  if (!capability?.settings || !draft) return false
  return draft.enabled !== capability.settings.enabled || draft.model !== capability.settings.model.value || (draft.variantChosen && draft.variant !== capability.settings.variant.value)
}
export const usablePreview = p => Boolean(p?.previewId && Date.parse(p.expiresAt) > Date.now())
export function changeSummary(c) {
  if(c.entrySummary){
    const {action,agentId,runtime}=c.entrySummary
    const labels={command:"可执行程序",args:"参数",cwd:"工作目录",wrapperModel:"包装层模型",timeoutMs:"超时（毫秒）",permissionMode:"权限策略"}
    return `${action==="create"?"创建":"删除"} ACP 代理 ${agentId} · `+Object.entries(labels).filter(([key])=>Object.hasOwn(runtime,key)).map(([key,label])=>`${label}：${JSON.stringify(runtime[key])}`).join("；")
  }
  if(c.field?.[0]==="disabled_agents" && typeof c.before==="boolean" && typeof c.after==="boolean")
    return `${c.before?"停用":"启用"} → ${c.after?"停用":"启用"}`
  return Object.hasOwn(c,"before")||Object.hasOwn(c,"after")?`${JSON.stringify(c.before??"默认")} → ${JSON.stringify(c.after??"默认")}`:"项目内容更新（仅受保护哈希摘要，无正文差异）"
}
