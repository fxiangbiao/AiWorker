---
name: scene-architecture
version: "1.0"
triggers:
  - 场景.*结构|scene|node.*树|嵌套|PackedScene|实例化
expert: game-dev
tools_required:
  - fs_write
model_preference: game-dev
---

# 场景架构设计

## 工作流程
1. 分析游戏的模块层级：从启动场景到具体游戏场景，拆解场景嵌套关系。
2. 设计节点树结构：确定根节点类型、子节点分组以及数据流向。
3. 规划场景复用：识别可抽象的通用场景（UI 组件、角色实体、效果），导出为 PackedScene 资源。
4. 用 `fs_write` 输出场景架构文档，包含节点树图示、场景文件清单和实例化关系。

## 节点树设计原则
- 根节点选型：2D 游戏用 `Node2D`，3D 游戏用 `Node3D`，UI 用 `Control` 族节点。
- 职责分离：每个场景只承担一项核心职责（玩家控制 OR  UI 显示 OR 数据管理），通过信号解耦通信。
- 可组合优于深度继承：将功能拆分为独立场景，通过组件方式挂载，而非层层继承导致逻辑纠缠。
- Autoload 单例用于全局服务（AudioManager、SaveManager、EventBus），不要将具体游戏逻辑放入 Autoload。

## PackedScene 资源管理
- 预加载关键场景：在类成员变量处使用 `preload("res://path.tscn")` 缓存，避免运行时路径查找。
- 延迟加载非关键场景：使用 `load()` 或 `ResourceLoader.load_threaded_request()` 实现按需加载。
- 频繁创建销毁的对象（子弹、特效、掉落物）使用 `PackedScene.instantiate()` + 对象池。
- 场景文件命名规范：`entity_{名称}.tscn`、`ui_{面板名}.tscn`、`level_{编号}.tscn`，方便搜索和定位。

## 场景切换流程
- 加载页设计：大型场景切换时显示过渡画面（loading screen），用 `ResourceLoader.load_threaded_request` + `_process` 轮询进度。
- 数据传递：通过 Autoload 或场景参数传递切换上下文，不要依赖全局变量隐式传参。
- 旧场景清理：切换前断开所有信号连接，释放纹理和音频资源，调用 `queue_free()` 清理节点树。

## 输出格式
```markdown
# 场景架构: {项目名称}

## 场景清单
| 场景文件 | 类型 | 根节点 | 职责 | 加载方式 |

## 节点树结构
```
Root (Node2D)
├── World (Node2D)
│   ├── TileMap
│   ├── Entities (Node2D)
│   │   ├── Player (PackedScene)
│   │   └── Enemies (Node2D)
│   └── Effects (Node2D)
├── UI (CanvasLayer)
│   ├── HUD (PackedScene)
│   └── PauseMenu (PackedScene)
└── GameManager (Autoload)
```

## 场景切换逻辑
- 加载页 → 主菜单 → 关卡选择 → 游戏关卡 → 结算页
- 数据传递方式与清理策略
```
