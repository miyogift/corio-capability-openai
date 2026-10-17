# Corio OpenAI 媒体插件

本包只依赖公开 corio-plugin-sdk，实现 image.generate、speech.synthesize 和 video.generate。连接指向 OpenAI 或兼容网关，不按模型名字切换协议。

在公司 Plugins 中选择 SDK 插件，登记 npm、Git 或 ZIP。连接字段由完整 manifest 提供；高级手风琴配置默认连接，Agent 可以 DEFAULT 继承或 CUSTOM 配置独立账户。与公司 Providers 无绑定。实例接收 baseUrl、apiKey、headers 及各操作默认模型；params.model 可覆盖该次模型。

本包是纯 HTTP 实现，生命周期返回 directory=null、command=null，不安装原生程序。固定 CORIO_USAGE.md 提供最终使用说明，由 Manager 投影到内置插件 Skill。

```sh
corio capability list
corio image generate --connection <id> --prompt-file prompt.md --width 1024 --height 1024 --params-file options.json
corio speech synthesize --connection <id> --text-file speech.md --voice alloy --format mp3
corio video generate --connection <id> --prompt-file prompt.md --duration 4
corio capability job get <local-job-id>
corio capability job wait <local-job-id>
```

标准尺寸翻译为 size，图片数量为 n，音频格式为 response_format，视频时长为 seconds。原生参数通过 params 传入，不能覆盖身份、凭据或已指定的标准参数。图像流式输出、视频文件型 multipart 参数暂不支持，在请求前拒绝。

生成文件保存在当前 Agent 的 artifacts/capabilities/；正式交付使用 corio file upload 与群消息附件。视频保存实际提供商 job ID，查询不重新提交生成。取消不可确认时返回 unknown，不把 DELETE 当作取消成功。外部产物下载不附原始模型密钥。

用量保留实际模型及可取得的 token、字符、产出数量或视频秒数；不伪造完整账单，费用由服务器计算。终态释放设备秘密及安装引用，保留已确认结果。

开发测试使用本地 HTTP 对端，不调用收费模型。发布制品必须包含 dist、corio.manifest.json、CORIO_USAGE.md、README。执行命令仍遵守仓库当前约束。
