export const VERSION = "6.1.0"
export function assertDraftCompatible(method, path, dirty) {
  if (!dirty || method === "GET" || (method === "POST" && ["/preview", "/reveal"].includes(path)) || (method === "PATCH" && path === "/config")) return
  const error = new Error("请先保存或明确放弃普通配置草稿，再执行其他修改。")
  error.code = "UNSAVED_DRAFT"; error.nextAction = "返回配置页处理草稿；当前草稿未改变。"
  throw error
}
// Exact OMO 3.0.8 ACP controls; other fields follow server classification.
export function fieldControl(path) {
  if (path.length !== 3 || path[0] !== "acpAgents") return null
  if (path[2] === "permissionMode") return { type: "select", options: ["ask", "allow", "reject"] }
  if (path[2] === "timeoutMs") return { type: "number", min: 0, max: 2147483647, step: 1 }
  return null
}
const ROUTES = new Set(["GET /health", "GET /snapshot", "GET /templates", "GET /contributions", "POST /reveal", "POST /preview", "PATCH /config", "POST /undo-preview", "POST /migration-preview", "POST /recover", "POST /template-preview", "POST /user-templates", "DELETE /user-templates", "PATCH /settings"])
export async function request(host, method, path, body) {
  if (!ROUTES.has(`${method} ${path}`)) throw new Error("INVALID_ROUTE")
  if (body && new TextEncoder().encode(JSON.stringify(body)).length > 63000) {
    const error = new Error("本次修改超过请求大小限制。")
    error.code = "BODY_TOO_LARGE"; error.nextAction = "缩小本次修改后再保存。"; throw error
  }
  const response = await host.serviceRequest({ method, path, ...(body === undefined ? {} : { body }) })
  let data
  try { data = typeof response.body === "string" ? JSON.parse(response.body) : response.body }
  catch { data = null }
  if (response.status < 200 || response.status >= 300 || data?.ok !== true) {
    const error = new Error(data?.error?.reason || "本地服务未完成请求。")
    Object.assign(error, {
      code: data?.error?.code || "SERVICE_UNAVAILABLE",
      resource: data?.error?.resource, field: data?.error?.field,
      nextAction: data?.error?.nextAction || "请检查宿主扩展服务权限，然后重新读取。",
      conflicts: data?.conflicts || data?.error?.conflicts || [],
    })
    throw error
  }
  return data
}
export const fieldKey = (resourceId, field) => JSON.stringify([resourceId, field])
export function containsProtected(value) {
  return value !== null && typeof value === "object" && (value.protected === true || Object.values(value).some(containsProtected))
}
export function parseValue(text, original) {
  if (typeof original === "string") return text
  return JSON.parse(text)
}
export function safeOperations(operations) {
  if (!Array.isArray(operations) || !operations.length || operations.length > 32) throw new Error("每次保存需要 1–32 项修改。")
  for (const op of operations) {
    if (typeof op.resourceId !== "string" || !Array.isArray(op.field) || !op.field.every(k => typeof k === "string")
      || !["set", "delete"].includes(op.action) || (op.action === "set" && (op.value === undefined || containsProtected(op.value)))) throw new Error("不能提交受保护占位或完整投影。请只修改普通字段。")
  }
  return operations.map(({ resourceId, field, action, value }) => ({ resourceId, field: [...field], action, ...(action === "set" ? { value } : {}) }))
}
export function usablePreview(preview, now = Date.now()) {
  return Boolean(preview && typeof preview.previewId === "string" && preview.previewId && Array.isArray(preview.changes)
    && typeof preview.expiresAt === "string" && Date.parse(preview.expiresAt) > now)
}
