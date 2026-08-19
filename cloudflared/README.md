# Cloudflare Tunnel 配置

`config.example.yml` 是不含秘密的配置模板。首次配置时在项目根目录执行：

```powershell
Copy-Item cloudflared/config.example.yml cloudflared/config.yml
```

然后在 Cloudflare 控制台创建 Tunnel，将凭证 JSON 保存为
`cloudflared/tunnel-credentials.json`，并在 `config.yml` 中替换 `tunnel` 的 UUID。
DNS 主机名固定为 `review.panspan.cloud`，源站是本机 Web 服务 `127.0.0.1:5173`。

本机 `.env.local` 只需确认以下配置，凭证和 `.env.local` 不得提交：

```dotenv
CLOUDFLARED_ENABLED=false
CLOUDFLARED_CONFIG=./cloudflared/config.yml
CLOUDFLARED_CREDENTIALS_FILE=./cloudflared/tunnel-credentials.json
CLOUDFLARED_PUBLIC_URL=https://review.panspan.cloud
PUBLIC_ACCESS_READY=false
```

配置完成后运行 `npm run tunnel:check` 校验 cloudflared 和 ingress 规则。`PUBLIC_ACCESS_READY=true`
在 PH5-04 账号密码门禁验收前必须保持为 `false`；启动脚本会拒绝提前开放 Tunnel。
