---
name: sprite-animation
version: "1.0"
description: "精灵动画状态机与帧动画设计"
triggers:
  - 动画|sprite|精灵|帧|Animated|动画.*设计
expert: game-dev
tools_required:
  - fs_write
model_preference: game-dev
---

# 精灵动画设计

## 工作流程
1. 确定角色的动画状态列表（idle、run、jump、attack、hurt、death 等），画出状态转换图。
2. 规划每个动画的帧数、帧速率和循环模式（是否衔接到其他动画）。
3. 设计动画参数：帧尺寸、锚点位置（pivot/origin）、各帧的碰撞框变化（如攻击帧扩大 hitbox）。
4. 用 `fs_write` 输出动画数据表（AnimationData）或动画设计文档，包含每帧的精灵索引和关键属性。

## 动画状态机设计
- 使用 `AnimationTree` + `AnimationNodeStateMachine` 管理角色动画，而非手动 `play()` 调用。
- 状态转换条件用 bool 参数（`is_running`、`is_grounded`）或 trigger 参数（`attack`、`jump`），避免字符串硬编码。
- 设定转换的交叉淡入淡出时间（blend time），让动作衔接顺滑，避免突兀跳变。

## 精灵表与帧数据
- 推荐使用 spritesheet（精灵序列图）组织同角色的所有帧，减少纹理切换开销。
- 使用 `AtlasTexture` 或 `SpriteFrames` 资源定义帧区域，避免运行时动态裁剪。
- 每帧命名遵循 `{动作}_{方向}_{序号}` 格式（如 `run_right_003`），便于程序化切换和管理。
- 帧事件回调：在 `SpriteFrames` 的 `Animation` 中绑定 `frame_changed` 信号，用于脚步声、攻击判定等关键帧触发。

## 性能与优化
- 动画帧数不宜过多：循环动画 4-8 帧即可，一次性动画（攻击/技能）8-16 帧。
- 远离屏幕的角色降低动画帧率（LOD），通过距离阈值跳过不必要的帧更新。
- 使用 `AnimatedSprite2D` 时确保 spritesheet 纹理图集尺寸为 2 的幂次方，充分利用 GPU 缓存。

## 输出格式
```markdown
# 动画设计: {角色/对象名称}

## 动画列表
| 动画名称 | 帧数 | 帧率 | 循环 | 过渡目标 |

## 状态转换图
idle ↔ run ↔ jump → fall → land → idle
idle → attack → idle
any → hurt → idle
any → death

## 帧数据
| 帧索引 | 精灵区域 (x,y,w,h) | 关键事件 | hitbox 变化 |

## SpriteFrames 资源配置
- 纹理路径 / Atlas 划分 / 锚点 / 缩放
```
