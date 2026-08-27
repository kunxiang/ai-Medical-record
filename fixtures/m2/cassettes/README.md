# M2 AI cassettes

工程验收设置 `AMR_AI_CASSETTE_DIR` 指向本目录，并保持 `AMR_AI_RECORD` 为空以强制离线回放。
需要录制新盒时显式设置 `AMR_AI_RECORD=1`；写盘前会在解码后的模型 JSON 上进行等长遮蔽，姓名和机构替换为 `P1` / `F1`，然后执行手机号和身份证号的独立正则门禁。

录制完成后必须运行：

```sh
pnpm --filter @amr/tools run scan-m2-pii
```

真实回归单据不放在这里；它们进入 `fixtures/m2/regression/`，并需要项目所有者先完成脱敏确认。
