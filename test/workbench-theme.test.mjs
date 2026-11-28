import test from "node:test"
import assert from "node:assert/strict"
import { readFile, mkdir, writeFile } from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"
import { applyHostReady } from "../openchamber/panel/vendor/theme.js"

// Flexoki light/dark values from installed OpenChamber 2.8.1:
// dist/assets/useAppFontEffects-CPBGYB39.js (g5e/b5e and x5e/w5e).
// SDK names: muted = surface.mutedForeground; mutedSurface = surface.muted.
const palettes = {
  light: {background:"#fffdf4",foreground:"#32302a",muted:"#6a6962",mutedSurface:"#f9f7ee",subtle:"#f7f4ec",elevated:"#f5f3ea",border:"#e6e4db",primary:"#b54f14",primaryForeground:"#fffdf4",hover:"#0000000a",focus:"#b54f1440"},
  dark: {background:"#171515",foreground:"#eeece3",muted:"#8b8a83",mutedSurface:"#121111",subtle:"#1e1d1c",elevated:"#201e1e",border:"#2b2a28d4",primary:"#DA702C",primaryForeground:"#171515",hover:"#ffffff0f",focus:"#DA702C50"},
}
function theme(mode) {
  const t = palettes[mode]
  return {mode,tokens:{...t,elevatedForeground:t.foreground,selection:t.subtle,selectionForeground:t.foreground,active:t.subtle,primaryText:t.primary,warningText:t.primary,errorText:t.primary,successText:t.foreground,infoText:t.foreground,warning:t.primary,error:t.primary,success:t.foreground,info:t.foreground,font:"system-ui",mono:"monospace",radius:"6px"}}
}

test("SDK ready theme mapping preserves semantic pairs across light/dark/light", () => {
  const props = new Map()
  const root = {style:{setProperty:(key,value)=>props.set(key,value)},dataset:{}}
  for (const mode of ["light","dark","light"]) {
    applyHostReady({theme:theme(mode),surface:"panel"},root)
    assert.equal(props.get("--oc-muted"),palettes[mode].muted)
    assert.equal(props.get("--oc-muted-surface"),palettes[mode].mutedSurface)
    assert.equal(props.get("--oc-primary-fg"),palettes[mode].primaryForeground)
    assert.equal(root.style.colorScheme,mode)
    assert.equal(root.dataset.ocTheme,mode)
  }
})

// Opt-in only: existing local Playwright, no installation or managed host.
test("actual panel CSS computed colors, contrast and live host palette switches", {
  skip: !process.env.WORKBENCH_PLAYWRIGHT ? "Set WORKBENCH_PLAYWRIGHT to an existing playwright module; no browser auto-install." : false,
  timeout:45000,
}, async t => {
  const {chromium} = await import(pathToFileURL(process.env.WORKBENCH_PLAYWRIGHT).href)
  let browser
  try { browser = await chromium.launch({executablePath:process.env.WORKBENCH_CHROMIUM || "/usr/bin/chromium",headless:true,timeout:12000,args:["--no-sandbox","--disable-dev-shm-usage"]}) }
  catch(error) { t.skip(`Single bounded browser launch unavailable: ${error.message}`); return }
  try {
    const page = await browser.newPage({viewport:{width:960,height:800},colorScheme:"dark"})
    await page.setContent(`<style>${await readFile(new URL("../openchamber/panel/panel.css",import.meta.url),"utf8")}</style>
      <div class="shell"><header><nav><button aria-current="page">角色</button><button>设置</button></nav></header>
      <div class="layout"><aside class="sidebar"><input placeholder="搜索角色"><div id="list"><button aria-current="true"><span class="roleline">orchestrator <span class="badge">不可停用</span></span><small>openai/gpt-6.1-sol</small></button></div></aside>
      <main class="detail"><h1>orchestrator</h1><p>模型</p><button class="model">openai/gpt-6.1-sol</button><small>目录中未确认 · 当前引用保留</small><p>思考等级</p><div class="segments"><button>默认</button><button aria-pressed="true">medium?</button></div><input value="示例"><div class="banner">目录待确认</div></main></div>
      <footer><button disabled>还原草稿</button><button class="primary">发布</button></footer></div>
      <dialog><h1>发布预览</h1><small>仅写入配置 · 待重载</small><input value="配置"><button class="primary">确认</button></dialog>`)
    await page.addScriptTag({content:(await readFile(new URL("../openchamber/panel/vendor/theme.js",import.meta.url),"utf8")).replaceAll("export const ","var ")})
    const evidence = []
    for (const mode of ["light","dark","light"]) {
      await page.evaluate(value=>applyHostReady({theme:value,surface:"panel"},document.documentElement),theme(mode))
      const result = await page.evaluate(() => {
        const rgb = value=>value.match(/[\d.]+/g).map(Number)
        const blend = (fg,bg)=>fg.slice(0,3).map((x,i)=>x*(fg[3]??1)+bg[i]*(1-(fg[3]??1)))
        const background = el=>{
          const c=rgb(getComputedStyle(el).backgroundColor)
          return blend(c,el.parentElement?background(el.parentElement):[255,255,255])
        }
        const lum = c=>c.map(x=>x/255).map(x=>x<=.04045?x/12.92:((x+.055)/1.055)**2.4).reduce((s,x,i)=>s+x*[.2126,.7152,.0722][i],0)
        return ["body","header [aria-current]","#list [aria-current]","#list small",".badge",".segments [aria-pressed=true]",".primary","input","button:disabled","dialog","dialog small"].map(selector=>{
          const el=document.querySelector(selector),s=getComputedStyle(el),bg=background(el)
          const a=lum(blend(rgb(s.color),bg)),b=lum(bg)
          return {selector,color:s.color,background:s.backgroundColor,contrast:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),minHeight:s.minHeight,fontSize:s.fontSize}
        })
      })
      for (const item of result) assert.ok(item.contrast>=4.5,`${mode} ${item.selector}: ${item.contrast}`)
      assert.equal(result.find(x=>x.selector==="input").fontSize,"16px")
      assert.equal(result.find(x=>x.selector===".primary").minHeight,"44px")
      const focus = await page.evaluate(()=>{
        const el=document.querySelector("input");el.focus()
        return {color:getComputedStyle(el).outlineColor,width:getComputedStyle(el).outlineWidth,scheme:getComputedStyle(document.documentElement).colorScheme}
      })
      assert.equal(focus.scheme,mode)
      assert.equal(focus.width,"2px")
      evidence.push({mode,result,focus})
      if (process.env.WORKBENCH_THEME_EVIDENCE) {
        await mkdir(process.env.WORKBENCH_THEME_EVIDENCE,{recursive:true})
        await page.screenshot({path:resolve(process.env.WORKBENCH_THEME_EVIDENCE,`${mode}.png`)})
      }
    }
    await page.evaluate(()=>document.querySelector("dialog").showModal())
    assert.equal(await page.locator("dialog").evaluate(el=>getComputedStyle(el,"::backdrop").backgroundColor),"rgba(0, 0, 0, 0.4)")
    await page.emulateMedia({colorScheme:"light"})
    await page.evaluate(()=>{document.documentElement.removeAttribute("style");document.documentElement.removeAttribute("data-oc-theme")})
    assert.equal(await page.locator("body").evaluate(el=>getComputedStyle(el).backgroundColor),"rgb(255, 255, 255)")
    await page.emulateMedia({colorScheme:"dark"})
    assert.equal(await page.locator("body").evaluate(el=>getComputedStyle(el).backgroundColor),"rgb(25, 28, 33)")
    if (process.env.WORKBENCH_THEME_EVIDENCE) await writeFile(resolve(process.env.WORKBENCH_THEME_EVIDENCE,"computed.json"),JSON.stringify(evidence,null,2))
  } finally {await browser.close()}
})
