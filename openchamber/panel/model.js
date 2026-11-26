export const VERSION = "6.0.0" // Shipped panel version, not a runtime observation.
export const VERSIONS = { omo: "3.0.8", opencode: "2.4.2", openchamber: "2.8.0" }
export const ACKNOWLEDGMENTS = [
  ["candidateRootConfirmed", "我已核对候选目录，确认它是当前 OMO 的用户配置根。"],
  ["defaultManagedLocalHost", "我使用本机默认 HOME/XDG 配置根和 OpenChamber 托管服务，不使用自定义根或外部服务器。"],
  ["hostEnvironmentChecked", "我已核对宿主及托管 OpenCode 的实际环境，包括 shell、service.json 和用户变量；没有指向其他根的覆盖。"],
  ["writerRuntimeDisabled", "我已确认托管进程未启用 OMO_COWORKERS_ENABLE_WRITER_ROLE=1。"],
  ["oldWriterStopped", "旧 dotfiles/安装器等写入流程已停止，不会并发覆盖这些文件。"],
  ["workPaused", "相关会话及配置编辑已暂停。"],
  ["managedBeforeValuesContainNoSecrets", "我已在本机检查将接管的现有提示词及托管字段，确认不含密钥、令牌或其他秘密；允许保存这些值以便回滚。"],
]
export function confirmations(checks, versions) {
  if (!ACKNOWLEDGMENTS.every(([key]) => checks[key] === true)
    || !Object.entries(VERSIONS).every(([key, value]) => versions[key] === value)) return null
  return { ...Object.fromEntries(ACKNOWLEDGMENTS.map(([key]) => [key, true])), versions: { ...versions } }
}
export async function request(host, path, body) {
  if (!["/status", "/preview", "/apply", "/rollback-preview", "/rollback", "/recover"].includes(path)) throw new Error("INVALID_ROUTE")
  const response = await host.serviceRequest({ method: path === "/status" ? "GET" : "POST", path, ...(body ? { body } : {}) })
  const data = typeof response.body === "string" ? JSON.parse(response.body) : response.body
  if (response.status < 200 || response.status >= 300 || data?.ok !== true) {
    const error = new Error(data?.error?.message || "服务请求未完成")
    error.code = data?.error?.code || "SERVICE_UNAVAILABLE"
    throw error
  }
  return data
}
export function usablePreview(preview, now = Date.now()) {
  return Boolean(preview && typeof preview.previewId === "string" && preview.previewId
    && ["apply", "rollback"].includes(preview.kind) && Date.parse(preview.expiresAt) > now)
}
