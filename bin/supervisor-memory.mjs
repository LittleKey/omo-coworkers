#!/usr/bin/env node
// supervisor-memory — 人审 CLI(P3)+ 精确补丁输出(P4)入口。
// 所有子命令与用法见 `supervisor-memory help`。
import { main } from "../plugins/supervisor/lib/memory/cli/cli.mjs"

const code = await main(process.argv.slice(2), {
  env: process.env,
  cwd: process.cwd(),
  home: process.env.HOME ?? process.env.USERPROFILE,
})
process.exitCode = code
