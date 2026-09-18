// Markdown renderer: turns the parsed MdNode tree into plain Taro
// View/Text nodes. No HTML string is ever built, so there is no injection
// surface — every text run lands in a <Text> the runtime escapes.
//
// `echarts` fences register a canvas chart (drawn page-level by the chat
// page's effect) and fall back to an ordinary code block when the option is
// not a JSON object or the canvas draw failed.

import { useEffect, useMemo, useState } from "react";
import { Canvas, Text, View } from "@tarojs/components";
import Taro from "@tarojs/taro";
import { parseChartOption, parseMarkdown, type Inline, type MdNode } from "@/lib/markdown";
import { chartStatus, registerChart, subscribeCharts } from "@/lib/charts";

function chartIdFor(text: string): string {
  // Stable id from the fence body so re-renders reuse the same canvas.
  let h = 5381;
  for (let i = 0; i < text.length; i++) {
    h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  }
  return `chart-${(h >>> 0).toString(36)}`;
}

function Inlines({ parts }: { parts: Inline[] }) {
  return (
    <>
      {parts.map((p, i) => {
        if (p.type === "code") {
          return (
            <Text key={i} className="md-code-inline">
              {p.text}
            </Text>
          );
        }
        if (p.type === "strong") {
          return (
            <Text key={i} className="md-strong">
              {p.text}
            </Text>
          );
        }
        if (p.type === "em") {
          return (
            <Text key={i} className="md-em">
              {p.text}
            </Text>
          );
        }
        if (p.type === "link") {
          return (
            <Text
              key={i}
              className="md-link"
              onClick={() => {
                // A mini program cannot open arbitrary external URLs; the
                // platform's affordance is copy-to-clipboard (with the URL
                // shown in the toast title so it stays visible).
                Taro.setClipboardData({ data: p.href }).catch(() => {});
                Taro.showToast({ title: "链接已复制", icon: "none" });
              }}
            >
              {p.text}
            </Text>
          );
        }
        return <Text key={i}>{p.text}</Text>;
      })}
    </>
  );
}

function CodeBlock({ lang, text }: { lang: string; text: string }) {
  return (
    <View className="md-code-block">
      {lang ? <Text className="md-code-lang">{lang}</Text> : null}
      <Text className="md-code-text" selectable userSelect>
        {text}
      </Text>
    </View>
  );
}

function ChartBlock({ text }: { text: string }) {
  const id = useMemo(() => chartIdFor(text), [text]);
  const option = useMemo(() => parseChartOption(text), [text]);
  const [, force] = useState(0);

  useEffect(() => subscribeCharts(() => force((v) => v + 1)), []);
  useEffect(() => {
    if (option) registerChart(id, option);
  }, [id, option]);

  if (!option || chartStatus(id) === "failed") {
    return <CodeBlock lang="echarts" text={text} />;
  }
  return (
    <View className="md-chart">
      <Canvas canvasId={id} id={id} className="md-chart-canvas" />
    </View>
  );
}

function Block({ node }: { node: MdNode }) {
  switch (node.kind) {
    case "heading": {
      const cls = `md-h md-h${Math.min(4, node.level)}`;
      return (
        <View className={cls}>
          <Text>
            <Inlines parts={node.inlines} />
          </Text>
        </View>
      );
    }
    case "paragraph":
      return (
        <View className="md-p">
          <Text selectable userSelect>
            <Inlines parts={node.inlines} />
          </Text>
        </View>
      );
    case "code":
      if (node.lang === "echarts") return <ChartBlock text={node.text} />;
      return <CodeBlock lang={node.lang} text={node.text} />;
    case "list":
      return (
        <View className="md-list">
          {node.items.map((item, i) => (
            <View key={i} className="md-li">
              <Text className="md-li-marker">{node.ordered ? `${i + 1}.` : "•"}</Text>
              <Text className="md-li-text" selectable userSelect>
                <Inlines parts={item} />
              </Text>
            </View>
          ))}
        </View>
      );
    case "quote":
      return (
        <View className="md-quote">
          <Text>
            <Inlines parts={node.inlines} />
          </Text>
        </View>
      );
    case "table":
      return (
        <View className="md-table">
          <View className="md-tr md-tr-header">
            {node.header.map((cell, i) => (
              <View key={i} className="md-td">
                <Text className="md-th-text">
                  <Inlines parts={cell} />
                </Text>
              </View>
            ))}
          </View>
          {node.rows.map((row, r) => (
            <View key={r} className="md-tr">
              {row.map((cell, c) => (
                <View key={c} className="md-td">
                  <Text>
                    <Inlines parts={cell} />
                  </Text>
                </View>
              ))}
            </View>
          ))}
        </View>
      );
    case "hr":
      return <View className="md-hr" />;
    default:
      return null;
  }
}

export function Markdown({ text }: { text: string }) {
  const nodes = useMemo(() => parseMarkdown(text), [text]);
  return (
    <View className="md">
      {nodes.map((node, i) => (
        <Block key={i} node={node} />
      ))}
    </View>
  );
}
