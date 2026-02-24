'use client';

import React, { useEffect, useRef, useState } from 'react';
import { LucideIcon, TrendingUp, TrendingDown, Minus } from 'lucide-react';

interface HistoryPoint {
  data: string;
  total: number;
}

interface StatsBadgeCardProps {
  icon: LucideIcon;
  label: string;
  total: number;
  totalOntem: number;
  crescimento: number;
  dataReferencia: string;
  online: boolean;
  history: HistoryPoint[];
  color: 'red' | 'orange' | 'blue' | 'green' | 'purple';
  countdown: number;
  maxCountdown: number;
  size?: 'default' | 'large';
  isLoading?: boolean;
}

const colorConfig = {
  red: {
    border: 'border-l-red-500',
    bg: 'bg-red-500/5',
    text: 'text-red-400',
    line: '#ef4444',
    fill: 'rgba(239, 68, 68, 0.1)',
  },
  orange: {
    border: 'border-l-orange-500',
    bg: 'bg-orange-500/5',
    text: 'text-orange-400',
    line: '#f97316',
    fill: 'rgba(249, 115, 22, 0.1)',
  },
  blue: {
    border: 'border-l-blue-500',
    bg: 'bg-blue-500/5',
    text: 'text-blue-400',
    line: '#3b82f6',
    fill: 'rgba(59, 130, 246, 0.1)',
  },
  green: {
    border: 'border-l-green-500',
    bg: 'bg-green-500/5',
    text: 'text-green-400',
    line: '#22c55e',
    fill: 'rgba(34, 197, 94, 0.1)',
  },
  purple: {
    border: 'border-l-purple-500',
    bg: 'bg-purple-500/5',
    text: 'text-purple-400',
    line: '#a855f7',
    fill: 'rgba(168, 85, 247, 0.1)',
  },
};

function formatNumber(num: number): string {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toLocaleString('pt-BR');
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '--/--';
  const date = new Date(dateStr);
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

interface SparklineDataPoint {
  value: number;
  label?: string;
}

function MiniSparkline({
  data,
  color,
  labels,
}: {
  data: number[];
  color: string;
  labels?: string[];
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ width: 200, height: 60 });
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const obs = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setDims({ width, height });
    });
    obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  if (!data.length) return null;

  const { width, height } = dims;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const padding = 2;

  const pointCoords = data.map((val, i) => ({
    x: padding + (i / (data.length - 1 || 1)) * (width - padding * 2),
    y: height - padding - ((val - min) / range) * (height - padding * 2),
    value: val,
  }));

  const polylinePoints = pointCoords.map((p) => `${p.x},${p.y}`).join(' ');
  const areaPath = `M ${padding},${height - padding} L ${polylinePoints} L ${width - padding},${height - padding} Z`;

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const mouseX = e.clientX - rect.left;
    // Find closest data point
    let closest = 0;
    let closestDist = Infinity;
    for (let i = 0; i < pointCoords.length; i++) {
      const dist = Math.abs(pointCoords[i].x - mouseX);
      if (dist < closestDist) {
        closestDist = dist;
        closest = i;
      }
    }
    setHoverIndex(closest);
  };

  const hoverPoint = hoverIndex !== null ? pointCoords[hoverIndex] : null;
  const hoverGrowth = hoverIndex !== null && hoverIndex > 0
    ? ((data[hoverIndex] - data[hoverIndex - 1]) / (data[hoverIndex - 1] || 1)) * 100
    : null;

  return (
    <div ref={containerRef} className="w-full h-full relative">
      <svg
        width="100%"
        height="100%"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="absolute inset-0 cursor-crosshair"
        onMouseMove={handleMouseMove}
        onMouseLeave={() => setHoverIndex(null)}
      >
        <defs>
          <linearGradient id={`gradient-${color}`} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor={color} stopOpacity="0.3" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={areaPath} fill={`url(#gradient-${color})`} />
        <polyline
          points={polylinePoints}
          fill="none"
          stroke={color}
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
        {/* Hover vertical line + dot */}
        {hoverPoint && (
          <>
            <line
              x1={hoverPoint.x}
              y1={0}
              x2={hoverPoint.x}
              y2={height}
              stroke="rgba(255,255,255,0.2)"
              strokeWidth="1"
              strokeDasharray="3,3"
            />
            <circle
              cx={hoverPoint.x}
              cy={hoverPoint.y}
              r={4}
              fill={color}
              stroke="#0a0e1a"
              strokeWidth="2"
            />
          </>
        )}
      </svg>
      {/* Tooltip */}
      {hoverPoint && hoverIndex !== null && (
        <div
          className="absolute z-10 pointer-events-none bg-[#0f1629]/95 border border-white/10 rounded-lg px-2.5 py-1.5 text-xs shadow-xl backdrop-blur-sm"
          style={{
            left: Math.min(hoverPoint.x, width - 100),
            top: -4,
            transform: 'translateY(-100%)',
          }}
        >
          {labels?.[hoverIndex] && (
            <div className="text-slate-400 text-[10px] mb-0.5">{labels[hoverIndex]}</div>
          )}
          <div className="text-white font-bold tabular-nums">{hoverPoint.value.toLocaleString('pt-BR')}</div>
          {hoverGrowth !== null && (
            <div className={`text-[10px] tabular-nums ${hoverGrowth >= 0 ? 'text-green-400' : 'text-red-400'}`}>
              {hoverGrowth >= 0 ? '+' : ''}{hoverGrowth.toFixed(2)}%
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CountdownRing({
  progress,
  color,
  size = 16,
}: {
  progress: number;
  color: string;
  size?: number;
}) {
  const radius = (size - 2) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - progress * circumference;

  return (
    <svg width={size} height={size} className="transform -rotate-90">
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke="rgba(255,255,255,0.1)"
        strokeWidth="1.5"
      />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        className="transition-all duration-1000"
      />
    </svg>
  );
}

export function StatsBadgeCard({
  icon: Icon,
  label,
  total,
  totalOntem,
  crescimento,
  dataReferencia,
  online,
  history,
  color,
  countdown,
  maxCountdown,
  size = 'default',
  isLoading = false,
}: StatsBadgeCardProps) {
  const config = colorConfig[color];
  const historyValues = history.map((h) => h.total);
  const historyLabels = history.map((h) => {
    const d = new Date(h.data);
    return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
  });
  const countdownProgress = countdown / maxCountdown;

  const growthIcon =
    crescimento > 0 ? TrendingUp : crescimento < 0 ? TrendingDown : Minus;
  const growthColor =
    crescimento > 0
      ? 'text-green-400'
      : crescimento < 0
        ? 'text-red-400'
        : 'text-slate-400';
  const growthText =
    crescimento >= 0 ? `+${crescimento.toFixed(2)}%` : `${crescimento.toFixed(2)}%`;

  const isLarge = size === 'large';

  return (
    <div
      className={`
        flex flex-col rounded-xl border border-white/5 ${config.border}
        ${config.bg} backdrop-blur-sm flex-1
        transition-all duration-300 hover:border-white/10 hover:shadow-lg
        ${isLarge ? 'border-l-[6px] min-w-[275px] h-[220px]' : 'border-l-[5px] min-w-[220px] h-[180px]'}
      `}
    >
      {/* Header - compact, flex-shrink-0 */}
      <div className={`flex-shrink-0 flex items-center justify-between border-b border-white/5 ${isLarge ? 'px-5 py-2' : 'px-4 py-1.5'}`}>
        <div className={`flex items-center min-w-0 ${isLarge ? 'gap-2.5' : 'gap-2'}`}>
          <Icon className={`flex-shrink-0 ${config.text} ${isLarge ? 'w-6 h-6' : 'w-5 h-5'}`} />
          <span className={`font-medium text-slate-300 truncate ${isLarge ? 'text-lg' : 'text-[15px]'}`}>{label}</span>
        </div>
        <div className={`flex items-center flex-shrink-0 ${isLarge ? 'gap-2.5' : 'gap-2'}`}>
          <span className={`text-slate-500 ${isLarge ? 'text-[13px]' : 'text-[11px]'}`}>{formatDate(dataReferencia)}</span>
          <div className="flex items-center gap-1.5">
            <div
              className={`rounded-full ${online ? 'bg-green-400 animate-pulse' : 'bg-slate-500'} ${isLarge ? 'w-2.5 h-2.5' : 'w-2 h-2'}`}
            />
            {isLoading ? (
              <svg className="animate-spin" width={isLarge ? 22 : 18} height={isLarge ? 22 : 18} viewBox="0 0 20 20" fill="none">
                <circle cx="10" cy="10" r="8" stroke="rgba(255,255,255,0.1)" strokeWidth="2" />
                <path d="M10 2 A8 8 0 0 1 18 10" stroke={config.line} strokeWidth="2" strokeLinecap="round" />
              </svg>
            ) : (
              <CountdownRing progress={countdownProgress} color={config.line} size={isLarge ? 22 : 18} />
            )}
          </div>
        </div>
      </div>

      {/* Body - Chart takes all remaining space (~90% of card) */}
      <div className="flex-1 min-h-0">
        <MiniSparkline
          data={historyValues}
          color={config.line}
          labels={historyLabels}
        />
      </div>

      {/* Footer - compact, 3 equal sections */}
      <div className={`flex-shrink-0 grid grid-cols-3 border-t border-white/5 ${isLarge ? 'py-1.5' : 'py-1'}`}>
        <div className={`flex items-center justify-center ${isLarge ? 'gap-1 text-xs' : 'gap-0.5 text-[10px]'}`}>
          <div className={`flex items-center ${growthColor} ${isLarge ? 'gap-1' : 'gap-0.5'}`}>
            {React.createElement(growthIcon, { className: isLarge ? 'w-3.5 h-3.5' : 'w-3 h-3' })}
            <span className="tabular-nums">{growthText}</span>
          </div>
        </div>
        <div className={`flex items-center justify-center border-x border-white/10 ${isLarge ? 'gap-1 text-xs' : 'gap-0.5 text-[10px]'}`}>
          <span className="text-slate-500">Total:</span>
          <span className="text-white font-semibold tabular-nums">{formatNumber(total)}</span>
        </div>
        <div className={`flex items-center justify-center ${isLarge ? 'gap-1 text-xs' : 'gap-0.5 text-[10px]'}`}>
          <span className="text-slate-500">Diario:</span>
          <span className={`font-semibold tabular-nums ${total - totalOntem >= 0 ? 'text-green-400' : 'text-red-400'}`}>
            {total - totalOntem >= 0 ? '+' : ''}{formatNumber(Math.abs(total - totalOntem))}
          </span>
        </div>
      </div>
    </div>
  );
}

// Refresh Pie Chart - animated circular countdown
export function RefreshPieChart({
  countdown,
  maxCountdown,
  onComplete,
  size = 32,
}: {
  countdown: number;
  maxCountdown: number;
  onComplete?: () => void;
  size?: number;
}) {
  const prevCountdownRef = useRef(countdown);
  const progress = 1 - countdown / maxCountdown; // 0 → 1 as time passes
  const radius = (size - 4) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - progress * circumference;

  useEffect(() => {
    if (prevCountdownRef.current > 0 && countdown <= 0) {
      onComplete?.();
    }
    prevCountdownRef.current = countdown;
  }, [countdown, onComplete]);

  const minutes = Math.floor(countdown / 60);
  const seconds = countdown % 60;
  const timeText = `${minutes}:${seconds.toString().padStart(2, '0')}`;

  return (
    <div className="flex items-center gap-1.5 flex-shrink-0">
      <svg width={size} height={size} className="transform -rotate-90">
        {/* Background circle */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="rgba(255,255,255,0.08)"
          strokeWidth="2.5"
        />
        {/* Progress arc */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke="#22d3ee"
          strokeWidth="2.5"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className="transition-all duration-1000 ease-linear"
        />
      </svg>
      <span className="text-[11px] text-slate-500 tabular-nums font-mono">{timeText}</span>
    </div>
  );
}

// Animated Counter Line Component
interface CounterLineProps {
  stats: Array<{
    label: string;
    value: number;
    color: 'red' | 'orange' | 'blue' | 'green' | 'purple';
  }>;
  countdown?: number;
  maxCountdown?: number;
  onRefreshComplete?: () => void;
}

function AnimatedNumber({ value, duration = 1500 }: { value: number; duration?: number }) {
  const [displayValue, setDisplayValue] = useState(0);
  const prevValueRef = useRef(0);

  useEffect(() => {
    const startValue = prevValueRef.current;
    const endValue = value;
    const startTime = performance.now();

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // Easing function (ease-out-cubic)
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = Math.round(startValue + (endValue - startValue) * eased);

      setDisplayValue(current);

      if (progress < 1) {
        requestAnimationFrame(animate);
      } else {
        prevValueRef.current = endValue;
      }
    };

    requestAnimationFrame(animate);
  }, [value, duration]);

  return <span className="tabular-nums">{displayValue.toLocaleString('pt-BR')}</span>;
}

export function StatsCounterLine({ stats, countdown, maxCountdown, onRefreshComplete }: CounterLineProps) {
  const colorMap = {
    red: 'text-red-400',
    orange: 'text-orange-400',
    blue: 'text-blue-400',
    green: 'text-green-400',
    purple: 'text-purple-400',
  };

  return (
    <div className="flex items-center justify-center gap-2 sm:gap-4 py-2 px-3 bg-[#0a0e1a]/80 border-y border-white/5">
      {stats.map((stat, index) => (
        <div key={stat.label} className="flex items-center gap-1 sm:gap-2">
          {index > 0 && <div className="w-px h-4 bg-white/10 mr-1 sm:mr-2" />}
          <span className={`text-[25px] leading-none font-bold ${colorMap[stat.color]}`}>
            <AnimatedNumber value={stat.value} />
          </span>
          <span className="text-xs text-slate-500 lowercase">{stat.label}</span>
        </div>
      ))}
      {countdown !== undefined && maxCountdown !== undefined && (
        <>
          <div className="w-px h-6 bg-white/10 mx-1" />
          <RefreshPieChart
            countdown={countdown}
            maxCountdown={maxCountdown}
            onComplete={onRefreshComplete}
          />
        </>
      )}
    </div>
  );
}
