# 第三方组件与再分发声明

本仓库随包分发以下第三方二进制，用于设备端界面读取（uiautomator2）。它们不是本项目原创，按 Apache License 2.0 再分发。

## 1. `vendor/u2.jar`

- 上游：openatx/uiautomator2（<https://github.com/openatx/uiautomator2>）
- 许可：Apache License 2.0
- 文件 sha256：`87c8ac9505970d42aa5922baa90114808fda6f47f9e5fbd4caa0f621c2c8d30d`
- 用途：设备端 `app_process` 加载，提供 JSON-RPC 界面树服务。
- 获取方式：由本项目脚本 push 到设备 `/data/local/tmp/`；上游 jar 内附带的 `LICENSE-junit.txt` 属于其打包依赖 junit，随 jar 保留。

## 2. `vendor/app-uiautomator.apk`

- 上游：openatx/uiautomator2（<https://github.com/openatx/uiautomator2>）
- 许可：Apache License 2.0
- 文件 sha256：`6f85594700ad96de89d012b3767049c2c6988510b68b31b439dd2a6dd93a30c9`
- 用途：设备端 uiautomator2 服务 APK，首次使用时安装。
- 说明：上游 APK 未内嵌 LICENSE/NOTICE 文件，本文件作为来源与许可声明。

## Apache License 2.0

全文见 <https://www.apache.org/licenses/LICENSE-2.0>。

```
Copyright 2017 openatx

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

本声明不构成法律意见；再分发前请自行核对上游最新许可与版本。
