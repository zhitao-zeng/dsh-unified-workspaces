# DSH Unified Workspaces

在 DeepSeek Harness 中统一管理本机和多台 SSH 服务器的工作区与原生会话。

Unified local and SSH remote workspaces for DeepSeek Harness. Each remote keeps its own native DSH frontend and session controller. Existing remote services and histories stay on their original hosts.

> 兼容基线：DSH **0.2.1-rc.5**、Node.js **24+**。当前为固定版本适配的实验性插件；其他 DSH 版本需要重新验证。

## 功能

- 本机工作区在前，多台远端工作区追加在同一侧栏，按自定义主机名称显示来源。
- 工作区标题只展开或收起；具体会话行打开所属主机的会话。
- 「远端工作台」查看各主机状态、工作区与会话，浏览目录、新建工作区和新建会话。
- 桌面/本机浏览器为每台远端保留一个按需加载的原生页面。跨主机往返只改变显示，不重建已经连接的页面。
- 远端使用自己的原生会话控制器、工作目录、模型与工具；不会把远端会话 ID 交给本机控制器。
- 外观和语言复用本机设置；模型、凭据和其他设置仍属于各自服务器。
- 使用现有 SSH 别名、端口转发、ProxyJump 或自建中继，不依赖特定 VPN。

首次嵌入需要远端至少有一个已有的非空白会话，用于原生界面安全恢复。全新空白 Host 请先通过其原生界面初始化会话；插件不会为了测试或加载目录自动创建会话。

本插件复用**已经运行 DSH 的服务器**。它不会远端安装 DSH、同步本机插件清单、启动另一套服务或重启现有服务。

## 安装

先确认本机与远端运行兼容的 DSH 版本。保存当前工作，等待任务空闲并退出桌面 App，再通过官方 CLI 修改桌面插件配置。

```sh
git clone https://github.com/zhitao-zeng/dsh-unified-workspaces.git
cd dsh-unified-workspaces
npm ci
npm run build
npm test
npm pack

dsh plugin --profile desktop add "file:$(pwd)/zhitao-zeng-dsh-unified-workspaces-0.5.0.tgz"
```

然后重新打开 DSH App。若 `dsh` 不在 PATH，使用官方桌面 App 自带的 `Contents/Resources/runtime/cli/bin/dsh`；按实际 App 安装目录填写其完整路径。

当前包通过 GitHub 源码和本地 tarball 分发，没有发布到 npm registry。仓库包括构建源与生成的客户端代码；不需要下载用户的运行配置或历史。

## 添加服务器

配置位于本机：

```text
~/.config/dsh-unified-workspaces/hosts.json
```

也可在启动 DSH 的环境中设置 `DSH_UNIFIED_CONFIG` 为该文件的绝对路径。配置不存在时只显示本机。主机配置在插件启动时加载，修改后正常重开 App 生效。

1. 为每台服务器准备一个已经验证主机指纹的 SSH 别名，确认免交互登录可用。
2. 建立独立的本机回环端口转发，指向远端已经运行的 DSH HTTP 端口。
3. 复制 `config.example.json`，填写主机 ID、显示名称、本机转发地址、已有远端 DSH Home 和凭据辅助程序的绝对路径。
4. 将配置文件设为仅当前用户可写，建议权限 `600`。

例如，已有 SSH 别名 `worker-a` 和 `worker-b` 时，可分别运行：

```sh
ssh -N -T -o ExitOnForwardFailure=yes -L 127.0.0.1:43081:127.0.0.1:3080 worker-a
ssh -N -T -o ExitOnForwardFailure=yes -L 127.0.0.1:43082:127.0.0.1:3080 worker-b
```

这两条命令需要各自保持运行。长期转发可由你已有的 SSH 或系统服务管理，本插件不创建后台 SSH 服务。自建中继只需配置在对应 SSH 别名中。

从旧定制版 0.4.1 迁移时，可在配置顶层增加 `"legacyHostId": "你的远端ID"`。它只把旧手机通道和旧主机选择映射到这台已配置服务器，仍使用同一授权与上游；不配置时不启用旧通道。旧手机页面刷新后改用新的通用路由。

配置示例：

```json
{
  "version": 1,
  "hosts": [
    {
      "id": "worker-a",
      "label": "训练服务器 A",
      "origin": "http://127.0.0.1:43081",
      "credentialCommand": [
        "/usr/bin/python3",
        "/ABSOLUTE/PATH/dsh-unified-workspaces/scripts/ssh-browser-cookie.py",
        "--ssh-host", "worker-a",
        "--dsh-home", "/home/your-user/.dsh",
        "--origin", "http://127.0.0.1:43081",
        "--remote-port", "3080"
      ]
    }
  ]
}
```

`config.example.json` 包含两台主机。每台主机的 ID 必须唯一；`mac` 保留给本机。origin 只接受本机回环 HTTP 地址，不接受公网地址、用户名密码或任意 URL 路径。

### 凭据辅助程序

随附脚本按 POSIX SSH 服务端验证，需要本机 Python 3、已有 SSH 访问，以及远端已经安装的 Python 3 和 PyYAML。其他服务端可提供自定义 `credentialCommand`；Windows SSH 及其 Shell 尚未实机验证。它从指定远端 DSH Home 读取**已有**浏览器授权材料，在远端签发五分钟有效的凭据，再验证现有 DSH listener。签名密钥留在远端，不复制到本机。插件允许最多两分钟的有限时钟偏差，凭据本身仍最多有效五分钟，最终签名和过期校验由远端 DSH 执行。

可以先只做状态检查：

```sh
python3 scripts/ssh-browser-cookie.py \
  --ssh-host worker-a \
  --dsh-home /home/your-user/.dsh \
  --origin http://127.0.0.1:43081 \
  --remote-port 3080 \
  --check
```

`--service your-existing.service` 可选，用于核对已经运行的 systemd 用户服务；不会启动服务。辅助程序不会创建缺失的 DSH Home 或授权材料。

配置中的 `credentialCommand` 不加 `--check`：它通过私有 stdout 返回 `{origin, active, cookieName, cookieValue}`，由插件在内存中捕获。只用 argv 数组执行，不经过 shell；不要把真实 Key 或 cookie 写进仓库、命令参数或日志。也可以替换成符合相同契约的自有凭据程序。

## 使用

- 新工作区：选择「＋本机工作区」或「＋远程工作区」，在工作台选择目标主机与目录。
- 新会话：在目标工作区行点「＋会话」，创建后明确打开。
- 本机原生「新会话」保持本机语义；远端使用对应工作区或工作台中的入口。
- 远端离线时显示自己的离线状态，不把该主机的会话交给其他主机执行。
- 桌面首次打开某台远端会加载其原生页面，随后保留页面和连接；网络中断、凭据租约失效后的下一次显式打开会重新确认。

## 手机与自建 HTTPS 入口

手机沿用你已有的 Remote Web UI 配对和 HTTPS 入口，仍可在统一列表选择不同主机。手机当前采用全页切换模式，尚未为每台主机部署独立 HTTPS 常驻页面。

自建入口需要转发正常 Remote Web UI 路径，以及插件 HTTP 路径 `/api/dsh-unified/`、`/remote/api/dsh-unified/` 和 WebSocket 路径 `/dsh-unified/hosts/<host-id>/remote.mux`。只转发标准 `/remote/api/remote.mux` 的入口需要补充这些插件路由。插件自身仍检查现有 owner 或设备配对授权，不新增公网 listener。

本机 `127.0.0.1` 嵌入页面不能直接用作手机入口。

## 模型和 API 配置

每个远端 DSH 使用自己的提供商配置。公开插件**不自动复制模型 Key、账号、浏览器授权或本机环境变量**。

若希望复用本机提供商，应显式选择目标服务器，通过 DSH 原生配置界面或正式配置 API 合并提供商和必要 Key，并核对远端能否访问对应地址。`127.0.0.1` 在每台服务器上指向它自己，不能假设本机 API 地址原样搬过去就可用。配置提供商与修改已有会话的模型是不同操作。

## 架构、验证与边界

详见 [架构与认证边界](docs/architecture.md)。构建和测试均不需要真实服务器、会话数据、API Key 或手机配对。多主机隔离、路由、长驻页面和授权在合成 HTTP/WS 与前端测试中验证；这不代表所有 DSH 版本、第三方插件或每种服务器平台都已实机验证。

此通用版本不自动替换其他名称的私有旧插件；不要同时启用两个都会接管工作区侧栏的插件。若从定制版本迁移，应先备份并等待任务空闲，再按官方插件流程切换。

## 许可与参考

MIT。原生目录浏览器派生代码、clsx 和架构参考项目的完整许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) 与 `licenses/`。

常驻远端页面和统一项目导航参考 [dsh-ssh-workspace](https://github.com/sincerity711/dsh-ssh-workspace)；这里使用配置驱动的多主机代理与现有远端服务，未运行其远端安装或环境同步流程。
