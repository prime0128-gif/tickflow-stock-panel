import { useEffect, useMemo, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import * as echarts from 'echarts'
import { RefreshCw } from 'lucide-react'
import { api, type MarketSentimentIndustryRow } from '@/lib/api'
import { QK } from '@/lib/queryKeys'
import { useChartTheme } from '@/lib/theme'

function useChart(option: echarts.EChartsOption | null) {
  const ref = useRef<HTMLDivElement>(null)
  const instance = useRef<echarts.ECharts | null>(null)
  useEffect(() => {
    if (!ref.current) return
    instance.current = echarts.init(ref.current)
    const resize = () => instance.current?.resize()
    window.addEventListener('resize', resize)
    return () => { window.removeEventListener('resize', resize); instance.current?.dispose(); instance.current = null }
  }, [])
  useEffect(() => { if (instance.current && option) instance.current.setOption(option, { notMerge: true }) }, [option])
  return ref
}

const card = 'rounded-card border border-border bg-surface/80 p-3 shadow-[0_1px_2px_hsl(var(--border)/0.4)]'

function Chart({ option }: { option: echarts.EChartsOption | null }) {
  const ref = useChart(option)
  return <div ref={ref} className="h-72 w-full" />
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className={card}><h2 className="mb-3 text-sm font-semibold text-foreground">{title}</h2>{children}</section>
}

function Missing({ text }: { text: string }) {
  return <div className="py-12 text-center text-xs text-muted">{text}</div>
}

function IndustryTable({ title, rows, positive }: { title: string; rows: MarketSentimentIndustryRow[]; positive: boolean }) {
  return <Section title={title}>
    <div className="overflow-x-auto"><table className="w-full text-xs"><thead className="text-muted"><tr><th className="pb-2 text-left font-normal">申万二级</th><th className="pb-2 text-right font-normal">MA5</th><th className="pb-2 text-right font-normal">MA10</th><th className="pb-2 text-right font-normal">周变化</th></tr></thead>
      <tbody>{rows.map(row => <tr key={row.sw_l2} className="border-t border-border/60"><td className="py-2 text-foreground">{row.sw_l2}</td><td className="py-2 text-right">{row.ma5.toFixed(1)}%</td><td className="py-2 text-right">{row.ma10.toFixed(1)}%</td><td className={`py-2 text-right ${positive ? 'text-bull' : 'text-bear'}`}>{(row.ma5_week_change ?? 0) >= 0 ? '+' : ''}{(row.ma5_week_change ?? 0).toFixed(1)}%</td></tr>)}</tbody>
    </table></div>
  </Section>
}

export function MarketSentiment() {
  const qc = useQueryClient()
  const chart = useChartTheme()
  const query = useQuery({ queryKey: QK.marketSentiment, queryFn: api.marketSentimentDashboard, staleTime: 5 * 60_000 })
  const data = query.data
  const breadthOption = useMemo<echarts.EChartsOption | null>(() => {
    if (!data?.breadth.length) return null
    const rows = data.breadth
    return { color: ['#60A5FA', '#F59E0B', '#A78BFA', '#F04438'], tooltip: { trigger: 'axis' }, legend: { textStyle: { color: chart.text } }, grid: { left: 48, right: 54, top: 36, bottom: 48 }, dataZoom: [{ type: 'inside' }, { type: 'slider', bottom: 8 }], xAxis: { type: 'category', data: rows.map(x => x.date), axisLabel: { color: chart.text }, axisLine: { lineStyle: { color: chart.border } } }, yAxis: [{ type: 'value', name: '市场宽度 (%)', min: 0, max: 100, axisLabel: { color: chart.text }, splitLine: { lineStyle: { color: chart.grid } } }, { type: 'value', name: '平均股价', axisLabel: { color: chart.text }, splitLine: { show: false } }], series: [20, 50, 120].map((n, i) => ({ name: `站上MA${n}`, type: 'line', smooth: true, showSymbol: false, yAxisIndex: 0, data: rows.map(x => x[`above_ma${n}` as keyof typeof x]), lineStyle: { width: 2, type: i === 2 ? 'dashed' : 'solid' } })).concat([{ name: '全市场平均股价', type: 'line', smooth: true, showSymbol: false, yAxisIndex: 1, data: rows.map(x => x.avg_price), lineStyle: { width: 2, type: 'solid' } }]) }
  }, [data?.breadth, chart])
  const shortOption = useMemo<echarts.EChartsOption | null>(() => {
    if (!data?.breadth.length) return null
    const rows = data.breadth
    return { color: ['#12B76A', '#F04438'], tooltip: { trigger: 'axis' }, legend: { textStyle: { color: chart.text } }, grid: { left: 48, right: 18, top: 36, bottom: 48 }, dataZoom: [{ type: 'inside' }, { type: 'slider', bottom: 8 }], xAxis: { type: 'category', data: rows.map(x => x.date), axisLabel: { color: chart.text }, axisLine: { lineStyle: { color: chart.border } } }, yAxis: { type: 'value', min: 0, max: 100, axisLabel: { color: chart.text, formatter: '{value}%' }, splitLine: { lineStyle: { color: chart.grid } } }, series: [5, 10].map(n => ({ name: `站上MA${n}`, type: 'line', smooth: true, showSymbol: false, data: rows.map(x => x[`above_ma${n}` as keyof typeof x]) })) }
  }, [data?.breadth, chart])
  const sectorsOption = useMemo<echarts.EChartsOption | null>(() => {
    if (!data?.watch_sectors.series.length) return null
    const dates = Array.from(new Set(data.watch_sectors.series.map(x => x.date)))
    const sectors = Array.from(new Set(data.watch_sectors.series.map(x => x.sector)))
    return { tooltip: { trigger: 'axis' }, legend: { type: 'scroll', textStyle: { color: chart.text } }, grid: { left: 48, right: 18, top: 48, bottom: 28 }, xAxis: { type: 'category', data: dates, axisLabel: { color: chart.text } }, yAxis: { type: 'value', min: 0, max: 100, axisLabel: { color: chart.text, formatter: '{value}%' }, splitLine: { lineStyle: { color: chart.grid } } }, series: sectors.map(sector => ({ name: sector, type: 'line', showSymbol: false, data: dates.map(day => data.watch_sectors.series.find(x => x.sector === sector && x.date === day)?.above_ma5 ?? null) })) }
  }, [data?.watch_sectors.series, chart])
  const pcrOption = useMemo<echarts.EChartsOption | null>(() => {
    if (!data?.pcr.series.length) return null
    const rows = data.pcr.series
    return { tooltip: { trigger: 'axis' }, legend: { textStyle: { color: chart.text } }, grid: { left: 48, right: 18, top: 36, bottom: 28 }, xAxis: { type: 'category', data: rows.map(x => x.date), axisLabel: { color: chart.text } }, yAxis: { type: 'value', name: 'Put/Call Ratio', axisLabel: { color: chart.text }, splitLine: { lineStyle: { color: chart.grid } } }, series: [{ name: '沪深300期权', type: 'line', showSymbol: false, data: rows.map(x => x.hs300) }, { name: '中证500期权', type: 'line', showSymbol: false, data: rows.map(x => x.zz500) }, { name: '科创50期权', type: 'line', showSymbol: false, data: rows.map(x => x.kc50) }] }
  }, [data?.pcr.series, chart])
  if (query.isLoading) return <div className="p-6 text-sm text-muted">正在加载市场情绪数据…</div>
  if (!data) return <div className="p-6 text-sm text-danger">市场情绪数据加载失败。</div>
  return <div className="min-h-full space-y-3 bg-base p-3"><header className="flex flex-wrap items-center gap-3"><div><h1 className="text-lg font-semibold text-foreground">市场情绪仪表盘</h1><p className="mt-1 text-xs text-muted">中国 A 股 · 数据截至 {data.as_of ?? '—'} · 市场宽度定义为收盘价站上对应均线的股票比例</p></div><button onClick={() => qc.invalidateQueries({ queryKey: QK.marketSentiment })} className="ml-auto inline-flex items-center gap-1 rounded-btn border border-border bg-elevated px-2 py-1 text-xs"><RefreshCw className="h-3.5 w-3.5" />刷新</button></header>
    <Section title="中长周期市场宽度与平均股价">{breadthOption ? <Chart option={breadthOption} /> : <Missing text="请先在“数据”页面完成日线与盘后指标流水线。" />}</Section>
    <Section title="短周期市场宽度（MA5 / MA10）">{shortOption ? <Chart option={shortOption} /> : <Missing text="暂无日线数据" />}</Section>
    <div className="grid gap-3 xl:grid-cols-2">{data.industry.available ? <><IndustryTable title="申万二级最强 10 个行业" rows={data.industry.best} positive /><IndustryTable title="申万二级最弱 10 个行业" rows={data.industry.worst} positive={false} /></> : <div className={`${card} xl:col-span-2`}><Missing text={`行业排名需要配置：${data.requirements.industry}`} /></div>}</div>
    <Section title="重点板块对比（近 15 个交易日）">{sectorsOption ? <Chart option={sectorsOption} /> : <Missing text={`板块对比需要配置：${data.requirements.watch_sectors}`} />}</Section>
    <Section title="期权 Put/Call Ratio">{pcrOption ? <Chart option={pcrOption} /> : <Missing text={`PCR 图需要配置：${data.requirements.pcr}`} />}</Section>
  </div>
}
