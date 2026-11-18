import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  Globe,
  History,
  Image as ImageIcon,
  Plus,
  RotateCcw,
  Save,
  Send,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import { HomepageView } from './HomepageView.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { mapFriendlyError } from '../lib/firestoreError.ts';
import {
  fetchCmsVersionHistory,
  fetchDraftHomepageCms,
  publishHomepageCms,
  rollbackHomepageCmsVersion,
  saveHomepageCmsDraft,
  uploadCmsAsset,
} from '../services/xpService.ts';
import {
  DEFAULT_HOMEPAGE_CMS,
  sanitizeHomepageCmsContent,
  validateCmsSecurity,
} from '../shared/cmsSanitizer.ts';
import { formatJakartaDateTime } from '../shared/xpLogic.ts';
import type {
  AdminUser,
  BranchInfo,
  CmsVersionRecord,
  HomepageCmsContent,
  LevelConfig,
  SystemSettings,
} from '../types/xpplay.ts';

interface AdminCmsEditorProps {
  adminProfile: AdminUser;
  levels: LevelConfig[];
  branches: BranchInfo[];
  systemSettings: SystemSettings;
  onFeedback: (fb: { type: 'success' | 'error'; text: string } | null) => void;
}

type AssetField = 'logoUrl' | 'faviconUrl' | 'heroImageUrl' | 'bannerImageUrl' | 'aboutImageUrl';

export function AdminCmsEditor({
  adminProfile,
  levels,
  branches,
  systemSettings,
  onFeedback,
}: AdminCmsEditorProps) {
  const { publishedHomepage, publishedCmsMeta, refreshPublishedCms } = useAuth();
  const canEdit = adminProfile.role === 'SUPER_ADMIN' || adminProfile.role === 'ADMIN';

  const [draft, setDraft] = useState<HomepageCmsContent>(publishedHomepage || DEFAULT_HOMEPAGE_CMS);
  const [draftMeta, setDraftMeta] = useState<{
    updatedAt: number;
    updatedByEmail: string;
    basePublishedVersionId: string | null;
  } | null>(null);
  const [versions, setVersions] = useState<CmsVersionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [uploadingField, setUploadingField] = useState<AssetField | null>(null);
  const [publishNote, setPublishNote] = useState('');
  const [showPublishConfirm, setShowPublishConfirm] = useState(false);
  const [previewTarget, setPreviewTarget] = useState<{
    title: string;
    content: HomepageCmsContent;
  } | null>(null);
  const [rollbackTarget, setRollbackTarget] = useState<CmsVersionRecord | null>(null);
  const [rollbackNote, setRollbackNote] = useState('');

  const loadAllCmsData = async () => {
    setLoading(true);
    try {
      const [draftRes, historyRes] = await Promise.all([
        fetchDraftHomepageCms(),
        fetchCmsVersionHistory(30),
      ]);
      setDraft(draftRes.content);
      setDraftMeta(
        draftRes.draft
          ? {
              updatedAt: draftRes.draft.updatedAt,
              updatedByEmail: draftRes.draft.updatedByEmail,
              basePublishedVersionId: draftRes.draft.basePublishedVersionId,
            }
          : null
      );
      setVersions(historyRes);
    } catch (err) {
      onFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadAllCmsData();
  }, []);

  const handleSaveDraft = async (e?: FormEvent) => {
    if (e) e.preventDefault();
    if (!canEdit) return;
    setBusy(true);
    onFeedback(null);
    try {
      const sec = validateCmsSecurity(draft);
      if (!sec.valid) throw new Error(sec.error);

      const saved = await saveHomepageCmsDraft({
        content: draft,
        admin: adminProfile,
        basePublishedVersionId: publishedCmsMeta?.versionId ?? null,
      });
      setDraft(saved.content);
      setDraftMeta({
        updatedAt: saved.updatedAt,
        updatedByEmail: saved.updatedByEmail,
        basePublishedVersionId: saved.basePublishedVersionId,
      });
      onFeedback({
        type: 'success',
        text: 'Draft CMS berhasil disimpan. Konten publik belum berubah sampai Anda klik Publish.',
      });
    } catch (err) {
      onFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmPublish = async () => {
    if (!canEdit) return;
    setBusy(true);
    onFeedback(null);
    try {
      const sec = validateCmsSecurity(draft);
      if (!sec.valid) throw new Error(sec.error);

      const res = await publishHomepageCms({
        content: draft,
        admin: adminProfile,
        note: publishNote,
      });
      await refreshPublishedCms();
      const historyRes = await fetchCmsVersionHistory(30);
      setVersions(historyRes);
      setDraft(res.published.content);
      setDraftMeta({
        updatedAt: res.published.updatedAt,
        updatedByEmail: res.published.publishedByEmail,
        basePublishedVersionId: res.version.versionId,
      });
      setShowPublishConfirm(false);
      setPublishNote('');
      onFeedback({
        type: 'success',
        text: `Homepage CMS versi ${res.version.versionId} berhasil dipublikasikan ke halaman depan.`,
      });
    } catch (err) {
      onFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmRollback = async () => {
    if (!canEdit || !rollbackTarget) return;
    setBusy(true);
    onFeedback(null);
    try {
      const res = await rollbackHomepageCmsVersion({
        targetVersion: rollbackTarget,
        admin: adminProfile,
        note: rollbackNote || `Rollback ke ${rollbackTarget.versionId}`,
      });
      await refreshPublishedCms();
      const historyRes = await fetchCmsVersionHistory(30);
      setVersions(historyRes);
      setDraft(res.published.content);
      setDraftMeta({
        updatedAt: res.published.updatedAt,
        updatedByEmail: res.published.publishedByEmail,
        basePublishedVersionId: res.version.versionId,
      });
      setRollbackTarget(null);
      setRollbackNote('');
      onFeedback({
        type: 'success',
        text: `Rollback berhasil! Versi baru ${res.version.versionId} dipublikasikan dari snapshot ${rollbackTarget.versionId}.`,
      });
    } catch (err) {
      onFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleAssetUpload = async (field: AssetField, file: File | undefined) => {
    if (!file || !canEdit) return;
    setUploadingField(field);
    onFeedback(null);
    try {
      const res = await uploadCmsAsset(file);
      setDraft((prev) => ({ ...prev, [field]: res.assetUrl }));
      onFeedback({
        type: 'success',
        text: `Gambar berhasil diunggah (${res.assetUrl}). Jangan lupa Simpan Draft / Publish.`,
      });
    } catch (err) {
      onFeedback({ type: 'error', text: mapFriendlyError(err) });
    } finally {
      setUploadingField(null);
    }
  };

  const handleAddFaq = () => {
    if (draft.faqItems.length >= 15) {
      onFeedback({ type: 'error', text: 'Maksimal 15 item FAQ.' });
      return;
    }
    setDraft((prev) => ({
      ...prev,
      faqItems: [
        ...prev.faqItems,
        {
          id: `faq_${Date.now()}`,
          question: 'Pertanyaan baru?',
          answer: 'Jawaban informatif untuk member XP PLAY.',
        },
      ],
    }));
  };

  if (loading) {
    return (
      <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-8 text-center text-sm text-slate-300">
        Memuat CMS Homepage Studio...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {!canEdit && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-xs text-amber-200">
          Mode Read-Only: Role STAFF hanya dapat melihat konfigurasi CMS Homepage. Perubahan draft, publish, dan rollback hanya diizinkan untuk ADMIN atau SUPER_ADMIN.
        </div>
      )}

      {/* Status Bar & Workflow Controls */}
      <div className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <Globe className="w-5 h-5 text-sky-400" />
            <h2 className="font-display text-lg font-bold text-white">CMS Homepage (Draft / Preview / Publish)</h2>
          </div>
          <p className="text-xs text-slate-300">
            Versi Live Published:{' '}
            <strong className="font-mono text-emerald-300">
              {publishedCmsMeta ? `${publishedCmsMeta.versionId} (${formatJakartaDateTime(publishedCmsMeta.publishedAt)} WIB)` : 'Default Template (Belum pernah dipublish)'}
            </strong>
            {draftMeta && (
              <>
                {' · '}Draft terakhir: <span className="font-mono text-sky-300">{formatJakartaDateTime(draftMeta.updatedAt)} WIB</span> ({draftMeta.updatedByEmail})
              </>
            )}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <button
            type="button"
            onClick={() =>
              setPreviewTarget({
                title: 'Live Preview Draft CMS (Belum Dipublikasikan)',
                content: sanitizeHomepageCmsContent(draft),
              })
            }
            className="inline-flex items-center gap-2 min-h-[40px] rounded-xl border border-sky-400/40 bg-[#070B19] px-3.5 py-2 text-xs font-semibold text-sky-300 hover:bg-sky-500/10"
          >
            <Eye className="w-4 h-4" />
            <span>Preview Draft</span>
          </button>

          <Link
            to="/?cmsPreview=draft"
            className="inline-flex items-center gap-1.5 min-h-[40px] rounded-xl border border-indigo-500/30 bg-[#070B19] px-3.5 py-2 text-xs font-semibold text-slate-200 hover:border-sky-400"
          >
            <span>Buka Halaman Preview</span>
          </Link>

          {canEdit && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleSaveDraft()}
                className="inline-flex items-center gap-2 min-h-[40px] rounded-xl border border-indigo-400/40 bg-indigo-950/60 px-4 py-2 text-xs font-semibold text-white hover:bg-indigo-900/70 disabled:opacity-50"
              >
                <Save className="w-4 h-4" />
                <span>{busy ? 'Menyimpan...' : 'Simpan Draft'}</span>
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => setShowPublishConfirm(true)}
                className="inline-flex items-center gap-2 min-h-[40px] rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-4 py-2 text-xs font-semibold text-white hover:from-blue-500 hover:to-purple-500 disabled:opacity-50"
              >
                <Send className="w-4 h-4" />
                <span>Publish Homepage</span>
              </button>
            </>
          )}
        </div>
      </div>

      {/* Main Editor Form */}
      <form onSubmit={handleSaveDraft} className="space-y-6">
        {/* 1. Brand, Logo, Favicon, Header */}
        <section className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-4">
          <h3 className="font-display text-sm font-bold text-white">1. Identitas Brand, Logo, Favicon &amp; Header</h3>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <FieldInput
              label="Nama XP PLAY / Brand *"
              value={draft.brandName}
              maxLength={60}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, brandName: v })}
            />
            <FieldInput
              label="Nama Toko & Title Browser *"
              value={draft.storeName}
              maxLength={120}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, storeName: v })}
            />
            <FieldInput
              label="Header Kicker / Tagline"
              value={draft.headerTagline}
              maxLength={120}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, headerTagline: v })}
            />
            <FieldInput
              label="Header CTA Button Text"
              value={draft.headerCtaText}
              maxLength={40}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, headerCtaText: v })}
            />
            <AssetUploadField
              label="Logo URL / Upload"
              value={draft.logoUrl}
              disabled={!canEdit}
              uploading={uploadingField === 'logoUrl'}
              onChange={(v) => setDraft({ ...draft, logoUrl: v })}
              onUpload={(f) => void handleAssetUpload('logoUrl', f)}
            />
            <AssetUploadField
              label="Favicon URL / Upload"
              value={draft.faviconUrl}
              disabled={!canEdit}
              uploading={uploadingField === 'faviconUrl'}
              onChange={(v) => setDraft({ ...draft, faviconUrl: v })}
              onUpload={(f) => void handleAssetUpload('faviconUrl', f)}
            />
          </div>
        </section>

        {/* 2. Hero & CTA */}
        <section className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-4">
          <h3 className="font-display text-sm font-bold text-white">2. Hero Section &amp; CTA</h3>
          <div className="grid sm:grid-cols-2 gap-4">
            <FieldInput
              label="Hero Title *"
              value={draft.heroTitle}
              maxLength={180}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, heroTitle: v })}
            />
            <FieldInput
              label="Hero Subtitle"
              value={draft.heroSubtitle}
              maxLength={180}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, heroSubtitle: v })}
            />
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-300 mb-1">Hero Description</label>
              <textarea
                rows={3}
                maxLength={600}
                disabled={!canEdit}
                value={draft.heroDescription}
                onChange={(e) => setDraft({ ...draft, heroDescription: e.target.value })}
                className="w-full rounded-lg border border-indigo-500/30 bg-[#070B19] p-3 text-sm text-white focus:border-sky-400 focus:outline-none disabled:opacity-60"
              />
            </div>
            <AssetUploadField
              label="Hero Image URL / Upload"
              value={draft.heroImageUrl}
              disabled={!canEdit}
              uploading={uploadingField === 'heroImageUrl'}
              onChange={(v) => setDraft({ ...draft, heroImageUrl: v })}
              onUpload={(f) => void handleAssetUpload('heroImageUrl', f)}
            />
            <div className="grid grid-cols-2 gap-3">
              <FieldInput
                label="CTA Utama Text"
                value={draft.ctaPrimaryText}
                maxLength={60}
                disabled={!canEdit}
                onChange={(v) => setDraft({ ...draft, ctaPrimaryText: v })}
              />
              <FieldInput
                label="CTA Utama URL"
                value={draft.ctaPrimaryUrl}
                maxLength={500}
                disabled={!canEdit}
                onChange={(v) => setDraft({ ...draft, ctaPrimaryUrl: v })}
              />
              <FieldInput
                label="CTA Sekunder Text"
                value={draft.ctaSecondaryText}
                maxLength={60}
                disabled={!canEdit}
                onChange={(v) => setDraft({ ...draft, ctaSecondaryText: v })}
              />
              <FieldInput
                label="CTA Sekunder URL"
                value={draft.ctaSecondaryUrl}
                maxLength={500}
                disabled={!canEdit}
                onChange={(v) => setDraft({ ...draft, ctaSecondaryUrl: v })}
              />
            </div>
          </div>
        </section>

        {/* 3. Announcement, Banner & Promo Banner */}
        <section className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-5">
          <h3 className="font-display text-sm font-bold text-white">3. Announcement, Banner &amp; Promo Banner</h3>

          <div className="rounded-xl border border-indigo-500/20 bg-[#070B19] p-4 space-y-3">
            <label className="flex items-center gap-2 text-xs font-semibold text-white">
              <input
                type="checkbox"
                disabled={!canEdit}
                checked={draft.announcementEnabled}
                onChange={(e) => setDraft({ ...draft, announcementEnabled: e.target.checked })}
              />
              <span>Aktifkan Announcement Bar di atas Header</span>
            </label>
            <FieldInput
              label="Teks Announcement"
              value={draft.announcementText}
              maxLength={240}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, announcementText: v })}
            />
          </div>

          <div className="rounded-xl border border-indigo-500/20 bg-[#070B19] p-4 space-y-3">
            <label className="flex items-center gap-2 text-xs font-semibold text-white">
              <input
                type="checkbox"
                disabled={!canEdit}
                checked={draft.bannerEnabled}
                onChange={(e) => setDraft({ ...draft, bannerEnabled: e.target.checked })}
              />
              <span>Aktifkan Highlight Banner</span>
            </label>
            <div className="grid sm:grid-cols-2 gap-3">
              <FieldInput
                label="Judul Banner"
                value={draft.bannerTitle}
                maxLength={160}
                disabled={!canEdit}
                onChange={(v) => setDraft({ ...draft, bannerTitle: v })}
              />
              <AssetUploadField
                label="Banner Image URL / Upload"
                value={draft.bannerImageUrl}
                disabled={!canEdit}
                uploading={uploadingField === 'bannerImageUrl'}
                onChange={(v) => setDraft({ ...draft, bannerImageUrl: v })}
                onUpload={(f) => void handleAssetUpload('bannerImageUrl', f)}
              />
              <div className="sm:col-span-2">
                <label className="block text-xs font-medium text-slate-300 mb-1">Deskripsi Banner</label>
                <textarea
                  rows={2}
                  maxLength={400}
                  disabled={!canEdit}
                  value={draft.bannerText}
                  onChange={(e) => setDraft({ ...draft, bannerText: e.target.value })}
                  className="w-full rounded-lg border border-indigo-500/30 bg-[#0B1124] p-2.5 text-sm text-white focus:border-sky-400 focus:outline-none disabled:opacity-60"
                />
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-indigo-500/20 bg-[#070B19] p-4 space-y-3">
            <label className="flex items-center gap-2 text-xs font-semibold text-white">
              <input
                type="checkbox"
                disabled={!canEdit}
                checked={draft.promoBannerEnabled}
                onChange={(e) => setDraft({ ...draft, promoBannerEnabled: e.target.checked })}
              />
              <span>Aktifkan Promo Banner</span>
            </label>
            <div className="grid sm:grid-cols-2 gap-3">
              <FieldInput
                label="Judul Promo Banner"
                value={draft.promoBannerTitle}
                maxLength={160}
                disabled={!canEdit}
                onChange={(v) => setDraft({ ...draft, promoBannerTitle: v })}
              />
              <FieldInput
                label="Teks Promo Banner"
                value={draft.promoBannerText}
                maxLength={400}
                disabled={!canEdit}
                onChange={(v) => setDraft({ ...draft, promoBannerText: v })}
              />
              <FieldInput
                label="Teks CTA Promo"
                value={draft.promoBannerCtaText}
                maxLength={60}
                disabled={!canEdit}
                onChange={(v) => setDraft({ ...draft, promoBannerCtaText: v })}
              />
              <FieldInput
                label="URL CTA Promo"
                value={draft.promoBannerCtaUrl}
                maxLength={500}
                disabled={!canEdit}
                onChange={(v) => setDraft({ ...draft, promoBannerCtaUrl: v })}
              />
            </div>
          </div>
        </section>

        {/* 4. About & Section Headings */}
        <section className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-4">
          <h3 className="font-display text-sm font-bold text-white">4. Tentang XP PLAY &amp; Section Homepage</h3>
          <div className="grid sm:grid-cols-2 gap-4">
            <FieldInput
              label="Judul Tentang XP PLAY"
              value={draft.aboutTitle}
              maxLength={140}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, aboutTitle: v })}
            />
            <AssetUploadField
              label="Section Image (Tentang XP PLAY)"
              value={draft.aboutImageUrl}
              disabled={!canEdit}
              uploading={uploadingField === 'aboutImageUrl'}
              onChange={(v) => setDraft({ ...draft, aboutImageUrl: v })}
              onUpload={(f) => void handleAssetUpload('aboutImageUrl', f)}
            />
            <div className="sm:col-span-2">
              <label className="block text-xs font-medium text-slate-300 mb-1">Deskripsi Tentang XP PLAY</label>
              <textarea
                rows={3}
                maxLength={1000}
                disabled={!canEdit}
                value={draft.aboutDescription}
                onChange={(e) => setDraft({ ...draft, aboutDescription: e.target.value })}
                className="w-full rounded-lg border border-indigo-500/30 bg-[#070B19] p-3 text-sm text-white focus:border-sky-400 focus:outline-none disabled:opacity-60"
              />
            </div>
            <FieldInput
              label="Judul Section Cara Kerja"
              value={draft.mechanicsTitle}
              maxLength={120}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, mechanicsTitle: v })}
            />
            <FieldInput
              label="Subjudul Section Cara Kerja"
              value={draft.mechanicsSubtitle}
              maxLength={300}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, mechanicsSubtitle: v })}
            />
            <FieldInput
              label="Judul Section Level"
              value={draft.levelsSectionTitle}
              maxLength={120}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, levelsSectionTitle: v })}
            />
            <FieldInput
              label="Subjudul Section Level"
              value={draft.levelsSectionSubtitle}
              maxLength={300}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, levelsSectionSubtitle: v })}
            />
            <FieldInput
              label="Judul Section Cabang"
              value={draft.branchesSectionTitle}
              maxLength={120}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, branchesSectionTitle: v })}
            />
          </div>
        </section>

        {/* 5. FAQ Editor */}
        <section className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <h3 className="font-display text-sm font-bold text-white">5. FAQ Section</h3>
              <label className="flex items-center gap-2 text-xs text-slate-300">
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={draft.faqEnabled}
                  onChange={(e) => setDraft({ ...draft, faqEnabled: e.target.checked })}
                />
                <span>Tampilkan Section FAQ di Halaman Depan</span>
              </label>
            </div>
            {canEdit && (
              <button
                type="button"
                onClick={handleAddFaq}
                className="inline-flex items-center gap-1.5 rounded-xl border border-sky-400/40 bg-[#070B19] px-3 py-1.5 text-xs font-semibold text-sky-300 hover:bg-sky-500/10"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Tambah FAQ</span>
              </button>
            )}
          </div>

          <FieldInput
            label="Judul Section FAQ"
            value={draft.faqTitle}
            maxLength={120}
            disabled={!canEdit}
            onChange={(v) => setDraft({ ...draft, faqTitle: v })}
          />

          <div className="space-y-3">
            {draft.faqItems.map((faq, idx) => (
              <div key={faq.id || idx} className="rounded-xl border border-indigo-500/20 bg-[#070B19] p-4 space-y-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-mono text-sky-300">FAQ #{idx + 1}</span>
                  {canEdit && (
                    <button
                      type="button"
                      onClick={() =>
                        setDraft({
                          ...draft,
                          faqItems: draft.faqItems.filter((_, i) => i !== idx),
                        })
                      }
                      className="text-xs text-rose-400 hover:text-rose-300 inline-flex items-center gap-1"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                      <span>Hapus</span>
                    </button>
                  )}
                </div>
                <input
                  type="text"
                  disabled={!canEdit}
                  maxLength={200}
                  placeholder="Pertanyaan"
                  value={faq.question}
                  onChange={(e) => {
                    const next = [...draft.faqItems];
                    next[idx] = { ...faq, question: e.target.value };
                    setDraft({ ...draft, faqItems: next });
                  }}
                  className="w-full h-9 rounded-lg border border-indigo-500/30 bg-[#0B1124] px-3 text-sm text-white focus:border-sky-400 focus:outline-none disabled:opacity-60"
                />
                <textarea
                  rows={2}
                  disabled={!canEdit}
                  maxLength={600}
                  placeholder="Jawaban"
                  value={faq.answer}
                  onChange={(e) => {
                    const next = [...draft.faqItems];
                    next[idx] = { ...faq, answer: e.target.value };
                    setDraft({ ...draft, faqItems: next });
                  }}
                  className="w-full rounded-lg border border-indigo-500/30 bg-[#0B1124] p-2.5 text-sm text-white focus:border-sky-400 focus:outline-none disabled:opacity-60"
                />
              </div>
            ))}
          </div>
        </section>

        {/* 6. Contact, Address, Maps, Hours, Social Media, Footer */}
        <section className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 p-5 space-y-4">
          <h3 className="font-display text-sm font-bold text-white">
            6. Kontak, Alamat, Jam Operasional, Google Maps, Social Media &amp; Footer
          </h3>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <FieldInput
              label="Judul Section Kontak"
              value={draft.contactTitle}
              maxLength={120}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, contactTitle: v })}
            />
            <FieldInput
              label="Deskripsi Kontak"
              value={draft.contactDescription}
              maxLength={400}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, contactDescription: v })}
            />
            <FieldInput
              label="Jam Operasional"
              value={draft.operatingHours}
              maxLength={120}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, operatingHours: v })}
            />
            <FieldInput
              label="Alamat Lengkap"
              value={draft.address}
              maxLength={260}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, address: v })}
            />
            <FieldInput
              label="Nomor WhatsApp Resmi"
              value={draft.whatsapp}
              maxLength={30}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, whatsapp: v })}
            />
            <FieldInput
              label="URL Google Maps"
              value={draft.mapsUrl}
              maxLength={500}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, mapsUrl: v })}
            />
            <FieldInput
              label="Instagram URL"
              value={draft.instagramUrl}
              maxLength={500}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, instagramUrl: v })}
            />
            <FieldInput
              label="TikTok URL"
              value={draft.tiktokUrl}
              maxLength={500}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, tiktokUrl: v })}
            />
            <FieldInput
              label="Facebook URL"
              value={draft.facebookUrl}
              maxLength={500}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, facebookUrl: v })}
            />
            <FieldInput
              label="YouTube URL"
              value={draft.youtubeUrl}
              maxLength={500}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, youtubeUrl: v })}
            />
            <FieldInput
              label="Teks Footer"
              value={draft.footerText}
              maxLength={300}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, footerText: v })}
            />
            <FieldInput
              label="Copyright Footer"
              value={draft.footerCopyright}
              maxLength={160}
              disabled={!canEdit}
              onChange={(v) => setDraft({ ...draft, footerCopyright: v })}
            />
          </div>
        </section>

        {canEdit && (
          <div className="flex flex-wrap items-center justify-end gap-3">
            <button
              type="submit"
              disabled={busy}
              className="inline-flex items-center gap-2 h-11 rounded-xl border border-indigo-400/40 bg-indigo-950/60 px-5 text-xs font-semibold text-white hover:bg-indigo-900/70 disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              <span>{busy ? 'Menyimpan...' : 'Simpan Draft'}</span>
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setShowPublishConfirm(true)}
              className="inline-flex items-center gap-2 h-11 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 px-6 text-xs font-semibold text-white hover:from-blue-500 hover:to-purple-500 disabled:opacity-50"
            >
              <Send className="w-4 h-4" />
              <span>Publish ke Production</span>
            </button>
          </div>
        )}
      </form>

      {/* Immutable Version History & Rollback */}
      <section className="bg-[#0B1124] rounded-2xl border border-indigo-500/20 overflow-hidden">
        <div className="p-4 border-b border-indigo-500/15 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <History className="w-4 h-4 text-sky-400" />
            <h3 className="font-display text-sm font-bold text-white">
              CMS Version History &amp; Rollback (Immutable)
            </h3>
          </div>
          <span className="text-xs text-slate-400">Riwayat versi tidak pernah dihapus</span>
        </div>
        <div className="divide-y divide-indigo-500/15">
          {versions.length === 0 ? (
            <div className="p-6 text-center text-sm text-slate-400">
              Belum ada versi CMS yang dipublikasikan. Simpan draft lalu klik Publish Homepage untuk membuat versi v1.
            </div>
          ) : (
            versions.map((ver) => {
              const isLive = publishedCmsMeta?.versionId === ver.versionId;
              return (
                <div
                  key={ver.versionId}
                  className="p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs"
                >
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono font-bold text-white text-sm">{ver.versionId}</span>
                      <span className="text-slate-400">·</span>
                      <span className="font-semibold text-sky-300">{ver.sourceAction}</span>
                      {ver.restoredFromVersionId && (
                        <span className="text-purple-300">
                          (dari {ver.restoredFromVersionId})
                        </span>
                      )}
                      {isLive && (
                        <span className="inline-flex items-center gap-1 text-emerald-300 font-semibold">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          LIVE PUBLISHED
                        </span>
                      )}
                    </div>
                    <p className="text-slate-300">{ver.note || 'Tanpa catatan'}</p>
                    <p className="text-slate-400 font-mono">
                      Oleh: {ver.publishedByEmail || ver.publishedBy} · {formatJakartaDateTime(ver.publishedAt)} WIB
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={() =>
                        setPreviewTarget({
                          title: `Preview Snapshot ${ver.versionId} (${formatJakartaDateTime(ver.publishedAt)} WIB)`,
                          content: sanitizeHomepageCmsContent(ver.content),
                        })
                      }
                      className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-[#070B19] px-3 py-1.5 font-semibold text-slate-200 hover:border-sky-400"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      <span>Lihat Versi</span>
                    </button>
                    {canEdit && !isLive && (
                      <button
                        type="button"
                        onClick={() => {
                          setRollbackTarget(ver);
                          setRollbackNote(`Rollback ke ${ver.versionId}`);
                        }}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/40 bg-amber-500/10 px-3 py-1.5 font-semibold text-amber-200 hover:bg-amber-500/20"
                      >
                        <RotateCcw className="w-3.5 h-3.5" />
                        <span>Rollback</span>
                      </button>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      {/* Publish Confirmation Modal */}
      {showPublishConfirm && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-[#0B1124] rounded-2xl border border-indigo-500/30 p-6 space-y-4">
            <h3 className="font-display text-lg font-bold text-white">Konfirmasi Publish Homepage</h3>
            <p className="text-xs text-slate-300 leading-relaxed">
              Perubahan akan langsung dipublikasikan ke halaman depan website dan dicatat sebagai versi baru pada riwayat CMS tanpa menghapus versi lama.
            </p>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">
                Catatan Versi (opsional)
              </label>
              <input
                type="text"
                maxLength={240}
                placeholder="Misal: Update banner promo akhir pekan"
                value={publishNote}
                onChange={(e) => setPublishNote(e.target.value)}
                className="w-full h-10 rounded-lg border border-indigo-500/30 bg-[#070B19] px-3 text-sm text-white focus:border-sky-400 focus:outline-none"
              />
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setShowPublishConfirm(false)}
                className="flex-1 h-10 rounded-xl border border-indigo-500/30 bg-[#070B19] text-xs font-semibold text-slate-200"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleConfirmPublish()}
                className="flex-1 h-10 rounded-xl bg-gradient-to-r from-blue-600 to-purple-600 text-xs font-semibold text-white disabled:opacity-50"
              >
                {busy ? 'Mempublikasikan...' : 'Konfirmasi Publish'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rollback Confirmation Modal */}
      {rollbackTarget && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-[#0B1124] rounded-2xl border border-amber-500/35 p-6 space-y-4">
            <div className="flex items-center gap-2 text-amber-300">
              <AlertTriangle className="w-5 h-5" />
              <h3 className="font-display text-lg font-bold text-white">
                Rollback ke {rollbackTarget.versionId}?
              </h3>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              Sistem akan membuat versi baru (tanpa menghapus riwayat sebelumnya) dengan konten dari snapshot <strong>{rollbackTarget.versionId}</strong> dan langsung memperbarui halaman depan.
            </p>
            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1">Alasan Rollback</label>
              <input
                type="text"
                maxLength={240}
                value={rollbackNote}
                onChange={(e) => setRollbackNote(e.target.value)}
                className="w-full h-10 rounded-lg border border-indigo-500/30 bg-[#070B19] px-3 text-sm text-white focus:border-sky-400 focus:outline-none"
              />
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={() => setRollbackTarget(null)}
                className="flex-1 h-10 rounded-xl border border-indigo-500/30 bg-[#070B19] text-xs font-semibold text-slate-200"
              >
                Batal
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => void handleConfirmRollback()}
                className="flex-1 h-10 rounded-xl bg-amber-600 text-xs font-semibold text-white hover:bg-amber-500 disabled:opacity-50"
              >
                {busy ? 'Memproses...' : 'Konfirmasi Rollback'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Full In-App Live Preview Modal */}
      {previewTarget && (
        <div className="fixed inset-0 z-50 bg-black/80 flex flex-col">
          <div className="bg-[#0B1124] border-b border-indigo-500/30 px-4 py-3 flex items-center justify-between gap-4">
            <span className="text-xs sm:text-sm font-semibold text-white">{previewTarget.title}</span>
            <button
              type="button"
              onClick={() => setPreviewTarget(null)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-indigo-500/30 bg-[#070B19] px-3 py-1.5 text-xs font-semibold text-white hover:border-sky-400"
            >
              <X className="w-4 h-4" />
              <span>Tutup Preview</span>
            </button>
          </div>
          <div className="flex-1 overflow-y-auto">
            <HomepageView
              cmsContent={previewTarget.content}
              levels={levels}
              branches={branches}
              systemSettings={systemSettings}
              memberProfile={null}
              adminProfile={adminProfile}
              hasUserSession={true}
              isPreviewMode={true}
              previewLabel={previewTarget.title}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function FieldInput({
  label,
  value,
  maxLength,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  maxLength: number;
  disabled?: boolean;
  onChange: (val: string) => void;
}) {
  return (
    <div>
      <label className="block text-xs font-medium text-slate-300 mb-1">{label}</label>
      <input
        type="text"
        maxLength={maxLength}
        disabled={disabled}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full h-10 rounded-lg border border-indigo-500/30 bg-[#070B19] px-3 text-sm text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none disabled:opacity-60"
      />
    </div>
  );
}

function AssetUploadField({
  label,
  value,
  disabled,
  uploading,
  onChange,
  onUpload,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  uploading?: boolean;
  onChange: (val: string) => void;
  onUpload: (file: File | undefined) => void;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-slate-300">{label}</label>
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <ImageIcon className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            maxLength={500}
            disabled={disabled}
            placeholder="https://... atau upload JPG/PNG/WEBP"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="w-full h-10 rounded-lg border border-indigo-500/30 bg-[#070B19] pl-8 pr-3 text-xs text-white placeholder:text-slate-500 focus:border-sky-400 focus:outline-none disabled:opacity-60"
          />
        </div>
        {!disabled && (
          <label className="inline-flex items-center gap-1.5 h-10 rounded-lg border border-sky-400/40 bg-[#070B19] px-3 text-xs font-semibold text-sky-300 hover:bg-sky-500/10 cursor-pointer shrink-0">
            <Upload className="w-3.5 h-3.5" />
            <span>{uploading ? '...' : 'Upload'}</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              className="hidden"
              disabled={uploading}
              onChange={(e) => {
                onUpload(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
        )}
      </div>
    </div>
  );
}
