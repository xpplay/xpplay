import { useState } from 'react';
import { ArrowRight, Check, Clock, Copy, Crown, Gift, Shield, Trophy, Users, Zap } from 'lucide-react';
import { formatJakartaDateTime, getBranchLabel, resolveLevelFromXp } from '../shared/xpLogic.ts';
import type { BranchId, LevelConfig, LevelId } from '../types/xpplay.ts';

interface MemberXpShowcaseProps {
  memberId: string;
  fullName: string;
  username: string;
  cycleId: string;
  xpProgress: number;
  xpReward: number;
  levels: LevelConfig[];
  lastPlayAt?: number | null;
  lastPlayBranch?: BranchId | null;
  referralCount?: number;
  onOpenBenefits?: () => void;
  previewMode?: boolean;
}

const LEVEL_STYLES: Record<
  LevelId,
  {
    accentText: string;
    emblemBg: string;
    cardBorder: string;
    barClass: string;
    Icon: typeof Shield;
  }
> = {
  BRONZE: {
    accentText: 'text-sky-300',
    emblemBg: 'from-slate-700/80 to-blue-900/80 border-sky-400/35 text-sky-300',
    cardBorder: 'border-sky-500/30',
    barClass: 'from-sky-400 to-blue-500',
    Icon: Shield,
  },
  SILVER: {
    accentText: 'text-cyan-300',
    emblemBg: 'from-sky-500/25 to-indigo-600/35 border-cyan-300/45 text-cyan-200',
    cardBorder: 'border-cyan-400/35',
    barClass: 'from-cyan-400 via-sky-400 to-blue-500',
    Icon: Zap,
  },
  JURAGAN: {
    accentText: 'text-indigo-300',
    emblemBg: 'from-blue-600/35 to-purple-600/45 border-indigo-400/50 text-indigo-200',
    cardBorder: 'border-indigo-400/45',
    barClass: 'from-sky-400 via-indigo-400 to-purple-500',
    Icon: Trophy,
  },
  SULTAN: {
    accentText: 'text-purple-300',
    emblemBg: 'from-purple-600/45 to-blue-600/45 border-purple-400/60 text-purple-200',
    cardBorder: 'border-purple-400/50',
    barClass: 'from-sky-400 via-blue-500 to-purple-500',
    Icon: Crown,
  },
};

export function MemberXpShowcase({
  memberId,
  fullName,
  username,
  cycleId,
  xpProgress,
  xpReward,
  levels,
  lastPlayAt,
  lastPlayBranch,
  referralCount = 0,
  onOpenBenefits,
  previewMode = false,
}: MemberXpShowcaseProps) {
  const [copied, setCopied] = useState(false);

  const levelEval = resolveLevelFromXp(xpProgress, levels);
  const sortedLevels = [...levels].sort((a, b) => a.rank - b.rank);
  const style = LEVEL_STYLES[levelEval.current.id] ?? LEVEL_STYLES.BRONZE;
  const LevelIcon = style.Icon;

  // Radial SVG progress ring math for XP Progress card
  const ringRadius = 32;
  const ringCircumference = 2 * Math.PI * ringRadius;
  const clampedPct = Math.max(0, Math.min(100, levelEval.progressPercent));
  const strokeOffset = ringCircumference - (clampedPct / 100) * ringCircumference;

  const handleCopyUsername = async () => {
    try {
      await navigator.clipboard.writeText(username);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard unavailable in restricted context
    }
  };

  return (
    <div className="grid lg:grid-cols-12 gap-5 items-stretch">
      {/* PRIMARY HERO LEVEL CARD */}
      <div
        className={`lg:col-span-7 relative overflow-hidden rounded-2xl border ${style.cardBorder} bg-gradient-to-br from-[#0B1536] via-[#121036] to-[#081026] p-5 sm:p-7 flex flex-col justify-between gap-6 shadow-[0_0_40px_-14px_rgba(59,130,246,0.45)]`}
      >
        {/* Subtle geometric ambient glow */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -top-20 -right-16 w-56 h-56 rounded-full bg-purple-600/20 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-20 -left-12 w-52 h-52 rounded-full bg-sky-500/20 blur-3xl"
        />

        {/* Top Identity Row */}
        <div className="relative flex flex-col sm:flex-row sm:items-start justify-between gap-4">
          <div className="space-y-1 min-w-0">
            <p className="text-xs font-mono text-sky-200/75 truncate">
              {previewMode ? 'Simulasi Kartu Member' : memberId} · @{username} · Cycle {cycleId}
            </p>
            <h1 className="font-display text-2xl sm:text-3xl font-extrabold tracking-tight text-white truncate">
              {fullName}
            </h1>
          </div>

          <div className="flex items-center gap-3 shrink-0 self-start sm:self-auto">
            <div
              className={`w-12 h-12 rounded-xl border bg-gradient-to-br ${style.emblemBg} flex items-center justify-center shadow-[0_0_24px_-4px_rgba(99,102,241,0.55)]`}
            >
              <LevelIcon className="w-6 h-6" />
            </div>
            <div className="text-left sm:text-right">
              <p className="text-[11px] font-medium text-slate-400">Level Saat Ini</p>
              <p className={`font-display text-xl sm:text-2xl font-extrabold tracking-tight uppercase ${style.accentText}`}>
                {levelEval.current.name}
              </p>
            </div>
          </div>
        </div>

        {/* XP Progress Track */}
        <div className="relative space-y-2.5">
          <div className="flex items-center justify-between gap-3 text-xs sm:text-sm">
            <span className="font-medium text-slate-200">
              {levelEval.next ? `Menuju Level ${levelEval.next.name}` : 'Tier Maksimal Tercapai'}
            </span>
            <span className="font-mono font-bold text-white tabular-nums">
              {levelEval.next ? `${xpProgress} / ${levelEval.next.minXp} XP` : `${xpProgress} XP`}
              <span className="text-sky-300 ml-2">({clampedPct}%)</span>
            </span>
          </div>

          <div className="h-3.5 w-full rounded-full bg-[#060917] border border-indigo-500/25 p-0.5 overflow-hidden">
            <div
              className={`h-full rounded-full bg-gradient-to-r ${style.barClass} transition-all duration-300 shadow-[0_0_16px_rgba(56,189,248,0.65)]`}
              style={{ width: `${clampedPct}%` }}
            />
          </div>

          <p className="text-xs text-slate-300">
            {levelEval.next
              ? `Butuh ${levelEval.xpToNext} XP Progress lagi untuk naik ke ${levelEval.next.name}.`
              : 'Seluruh level dan benefit tertinggi XP PLAY sudah terbuka.'}
          </p>
        </div>

        {/* 4-Stage Level Milestone Strip */}
        <div className="relative pt-4 border-t border-indigo-400/20 grid grid-cols-4 gap-2">
          {sortedLevels.map((lvl) => {
            const reached = xpProgress >= lvl.minXp;
            const isCurrent = lvl.id === levelEval.current.id;
            return (
              <div
                key={lvl.id}
                className={`rounded-xl px-2.5 py-2 border transition-colors ${
                  isCurrent
                    ? 'bg-indigo-500/20 border-sky-400/50'
                    : reached
                      ? 'bg-[#09112A]/80 border-indigo-500/25'
                      : 'bg-[#060917]/60 border-slate-800/80 opacity-65'
                }`}
              >
                <p
                  className={`font-display text-[11px] sm:text-xs font-bold truncate ${
                    isCurrent ? 'text-sky-300' : reached ? 'text-white' : 'text-slate-400'
                  }`}
                >
                  {lvl.name}
                </p>
                <p className="font-mono text-[10px] sm:text-[11px] text-slate-400 tabular-nums mt-0.5">
                  {lvl.minXp}+ XP
                </p>
              </div>
            );
          })}
        </div>
      </div>

      {/* DUAL XP BALANCE CARDS + LAST PLAY / REFERRAL */}
      <div className="lg:col-span-5 grid grid-cols-2 gap-4">
        {/* XP PROGRESS CARD */}
        <div className="rounded-2xl border border-sky-500/30 bg-[#0B1124] p-4 sm:p-5 flex flex-col justify-between gap-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-xs font-medium text-sky-300">XP Progress</p>
              <p className="mt-1.5 font-mono text-2xl sm:text-3xl font-extrabold text-white tabular-nums">
                {xpProgress}
                <span className="text-sm font-semibold text-sky-300 ml-1">XP</span>
              </p>
            </div>
            <div className="relative w-14 h-14 sm:w-16 sm:h-16 shrink-0 flex items-center justify-center">
              <svg className="w-full h-full -rotate-90" viewBox="0 0 76 76" aria-hidden="true">
                <circle
                  cx="38"
                  cy="38"
                  r={ringRadius}
                  fill="none"
                  stroke="rgba(56, 189, 248, 0.16)"
                  strokeWidth="6"
                />
                <circle
                  cx="38"
                  cy="38"
                  r={ringRadius}
                  fill="none"
                  stroke="#38BDF8"
                  strokeWidth="6"
                  strokeLinecap="round"
                  strokeDasharray={ringCircumference}
                  strokeDashoffset={strokeOffset}
                />
              </svg>
              <span className="absolute font-mono text-[11px] font-bold text-sky-200 tabular-nums">
                {clampedPct}%
              </span>
            </div>
          </div>
          <p className="text-xs text-slate-400 leading-relaxed">
            Penentu level keanggotaan. Tidak berkurang saat redeem.
          </p>
        </div>

        {/* XP REWARD CARD */}
        <div className="rounded-2xl border border-purple-500/35 bg-gradient-to-br from-[#0E112B] to-[#170F33] p-4 sm:p-5 flex flex-col justify-between gap-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="text-xs font-medium text-purple-300">XP Reward</p>
              <p className="mt-1.5 font-mono text-2xl sm:text-3xl font-extrabold text-white tabular-nums">
                {xpReward}
                <span className="text-sm font-semibold text-purple-300 ml-1">XP</span>
              </p>
            </div>
            <div className="w-10 h-10 rounded-xl bg-purple-500/20 border border-purple-400/35 text-purple-300 flex items-center justify-center shrink-0">
              <Gift className="w-5 h-5" />
            </div>
          </div>

          {onOpenBenefits ? (
            <button
              type="button"
              onClick={onOpenBenefits}
              className="inline-flex items-center justify-between gap-2 w-full min-h-[38px] rounded-xl bg-purple-600/25 border border-purple-400/35 px-3 py-1.5 text-xs font-semibold text-purple-200 hover:bg-purple-600/40 hover:text-white transition-colors"
            >
              <span>Tukar Benefit</span>
              <ArrowRight className="w-3.5 h-3.5 shrink-0" />
            </button>
          ) : (
            <p className="text-xs text-slate-400 leading-relaxed">
              Saldo aktif untuk ditukar benefit atau reward spesial.
            </p>
          )}
        </div>

        {/* LAST PLAY & REFERRAL STRIP */}
        {!previewMode && (
          <div className="col-span-2 rounded-2xl border border-indigo-500/20 bg-[#0B1124] p-4 sm:p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="space-y-1 min-w-0">
              <p className="text-xs font-medium text-slate-400 flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-sky-400 shrink-0" />
                <span>Terakhir Main (Last Play)</span>
              </p>
              <p className="font-display text-sm sm:text-base font-bold text-white truncate">
                {lastPlayAt ? `${formatJakartaDateTime(lastPlayAt)} WIB` : 'Belum ada riwayat main'}
              </p>
              <p className="text-xs text-slate-400">
                Cabang: <span className="text-slate-200">{getBranchLabel(lastPlayBranch || null)}</span>
              </p>
            </div>

            <div className="flex sm:flex-col items-center sm:items-end justify-between gap-2 pt-3 sm:pt-0 border-t sm:border-t-0 border-indigo-500/15 shrink-0">
              <div className="sm:text-right">
                <p className="text-xs text-slate-400 flex items-center sm:justify-end gap-1">
                  <Users className="w-3.5 h-3.5 text-purple-400" />
                  <span>Referral</span>
                </p>
                <p className="font-mono text-lg font-bold text-white tabular-nums">
                  {referralCount} teman
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleCopyUsername()}
                className="inline-flex items-center gap-1.5 min-h-[38px] rounded-xl border border-indigo-400/30 bg-[#070B19] px-3 py-1.5 text-xs font-mono font-semibold text-sky-300 hover:border-sky-400 hover:text-white transition-colors"
              >
                {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
                <span>{copied ? 'Tersalin!' : `@${username}`}</span>
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
