// One chat turn: the user message, or the assistant's block sequence
// (text / thinking / tool / skill / command / error).
//
// The streaming rule lives here: a TEXT block renders as plain text while its
// turn is streaming and switches to rendered markdown once the turn closes —
// re-parsing markdown per chunk is the classic mini-program perf trap.

import { Text, View } from "@tarojs/components";
import { useChatStore, type Block, type Turn } from "@platform/core";
import { Markdown } from "./Markdown";

function ToolBlock({ block, onToggle }: { block: Extract<Block, { kind: "tool" }>; onToggle: () => void }) {
  const stateLabel = block.state === "running" ? "运行中" : block.state === "error" ? "失败" : "完成";
  return (
    <View className={`blk blk-tool blk-tool-${block.state}`}>
      <View className="blk-head" onClick={onToggle}>
        <Text className="blk-icon">🔧</Text>
        <Text className="blk-title">{block.name}</Text>
        <Text className={`blk-state blk-state-${block.state}`}>{stateLabel}</Text>
      </View>
      {block.open ? (
        <Text className="blk-pre" selectable userSelect>
          {formatPayload(block.result ?? block.partial ?? block.args)}
        </Text>
      ) : null}
    </View>
  );
}

function formatPayload(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function BlockView({ block, streaming, onToggle }: { block: Block; streaming: boolean; onToggle: () => void }) {
  switch (block.kind) {
    case "text":
      return (
        <View className="blk blk-text">
          {streaming ? (
            <Text className="blk-text-plain" selectable userSelect>
              {block.text}
            </Text>
          ) : (
            <Markdown text={block.text} />
          )}
        </View>
      );
    case "thinking":
      return (
        <View className="blk blk-thinking">
          <View className="blk-head" onClick={onToggle}>
            <Text className="blk-icon">💭</Text>
            <Text className="blk-title">{streaming && block.open ? "思考中…" : "思考过程"}</Text>
            <Text className="blk-toggle">{block.open ? "收起" : "展开"}</Text>
          </View>
          {block.open ? (
            <Text className="blk-pre blk-thinking-text" selectable userSelect>
              {block.text}
            </Text>
          ) : null}
        </View>
      );
    case "tool":
      return <ToolBlock block={block} onToggle={onToggle} />;
    case "skill":
      return (
        <View className="blk blk-skill">
          <View className="blk-head" onClick={onToggle}>
            <Text className="blk-icon">⚡</Text>
            <Text className="blk-title">技能 {block.name}</Text>
            {block.args ? <Text className="blk-toggle">{block.args}</Text> : null}
          </View>
        </View>
      );
    case "command":
      return (
        <View className="blk blk-command">
          <View className="blk-head" onClick={onToggle}>
            <Text className="blk-icon">▶</Text>
            <Text className="blk-title">/{block.name}</Text>
          </View>
          {block.message ? <Text className="blk-pre">{block.message}</Text> : null}
        </View>
      );
    case "error":
      return (
        <View className="blk blk-error">
          <Text className="blk-error-text">{block.message}</Text>
        </View>
      );
    default:
      return null;
  }
}

export function TurnView({ turn }: { turn: Turn }) {
  const toggleBlock = useChatStore((s) => s.toggleBlock);

  if (turn.role === "user") {
    return (
      <View className="turn turn-user">
        <Text className="turn-user-text" selectable userSelect>
          {turn.text}
        </Text>
      </View>
    );
  }

  return (
    <View className="turn turn-assistant">
      {turn.blocks.map((b, i) => (
        <BlockView key={i} block={b} streaming={turn.streaming} onToggle={() => toggleBlock(turn.id, i)} />
      ))}
      {turn.streaming ? <Text className="turn-cursor">▍</Text> : null}
      {turn.interrupted ? <Text className="turn-interrupted">回答已中断</Text> : null}
    </View>
  );
}
