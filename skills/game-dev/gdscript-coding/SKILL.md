---
name: gdscript-coding
version: "1.0"
description: "Godot GDScript 脚本编写与调试"
triggers:
  - GDScript|gdscript|脚本|signal|协程|godot.*代码
expert: game-dev
tools_required:
  - fs_write
  - fs_read
model_preference: game-dev
---

# GDScript 编码

## 工作流程
1. 用 `fs_read` 读取要修改的 `.gd` 脚本文件，理解现有逻辑和类结构。
2. 确定需求所属的节点层级：场景根节点 → 子组件 → 单例（autoload），选择合适的作用域。
3. 编写 GDScript 代码，遵循 Godot 官方命名规范（snake_case 变量/函数, PascalCase 类名, 常量全大写）。
4. 用 `fs_write` 输出或更新脚本文件，确保 `extends` 声明正确、信号连接清晰。

## 代码结构规范
- 每个脚本第一行为 `extends` 声明，明确继承的类（Node、Node2D、Control 等）。
- 变量声明区按顺序排列：`@export` 变量 → `@onready` 变量 → 普通变量 → 常量。
- 函数按生命周期顺序排列：`_ready()` → `_process(delta)` → `_physics_process(delta)` → 自定义方法。
- 使用 `class_name` 注册全局类名，便于在其他脚本中类型引用和实例化。

## 信号与协程
- 信号声明放在文件顶部（变量区之后），使用 `signal` 关键字注册自定义信号。
- 连接信号优先使用编辑器拖拽方式，若需代码连接则在 `_ready()` 中调用 `signal_name.connect(_on_signal_name)`。
- 协程使用 `await` 关键字（Godot 4.x），避免使用旧版 `yield`；异步操作如 `await get_tree().create_timer(1.0).timeout`。
- 耗时操作（场景加载、网络请求）必须使用协程，防止主线程阻塞导致帧率下降。

## Type Hints 与安全
- 成员变量声明时显式标注类型：`var health: int = 100`，函数参数和返回值同样标注。
- 使用 `@onready` 替代在 `_ready()` 中手动赋值 `$NodePath`，代码更简洁且安全性一致。
- 空值检查：对可能为 null 的节点引用，使用 `if is_instance_valid(node):` 或 `if node != null:` 防护。
- 避免在 `_process` 中执行重操作，将不频繁的逻辑放入 timers 或信号回调中。

## 性能建议
- 用 `@onready var label = $Label` 缓存节点引用，避免每帧调用 `$Label` 做路径查找。
- 大量同类型对象使用对象池模式，预创建、复用而非频繁 `queue_free` + `add_child`。
- 使用 `match` 替代多层 `if-elif`，`match` 在 Godot 中编译为跳转表，性能更优。

## 输出格式
```gdscript
# {脚本文件名}.gd
extends Node2D
class_name PlayerController

# 信号声明
signal health_changed(new_health: int)

# 导出变量
@export var speed: float = 300.0
@export var jump_force: float = -400.0

# 就绪引用
@onready var sprite: Sprite2D = $Sprite2D
@onready var animation: AnimationPlayer = $AnimationPlayer

# 变量
var health: int = 100
var is_jumping: bool = false

const MAX_SPEED: float = 600.0

func _ready() -> void:
    # 初始化逻辑
    pass

func _physics_process(delta: float) -> void:
    # 物理更新逻辑
    pass

# 自定义方法
func take_damage(amount: int) -> void:
    pass
```
