import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { HomepageView } from '../components/HomepageView.tsx';
import { useAuth } from '../context/AuthContext.tsx';
import { fetchDraftHomepageCms } from '../services/xpService.ts';
import { sanitizeCmsImageUrl } from '../shared/cmsSanitizer.ts';
import { DEFAULT_BRANCHES, DEFAULT_LEVELS } from '../shared/xpLogic.ts';
import type { HomepageCmsContent } from '../types/xpplay.ts';

export function LandingPage() {
  const {
    firebaseUser,
    memberProfile,
    adminProfile,
    levels,
    branches,
    systemSettings,
    publishedHomepage,
  } = useAuth();
  const [searchParams] = useSearchParams();
  const [draftContent, setDraftContent] = useState<HomepageCmsContent | null>(null);

  const displayLevels = levels.length ? levels : DEFAULT_LEVELS;
  const displayBranches = branches.length ? branches : DEFAULT_BRANCHES;

  const isPrivilegedCmsAdmin =
    Boolean(adminProfile?.active) &&
    (adminProfile?.role === 'SUPER_ADMIN' || adminProfile?.role === 'ADMIN');
  const wantsDraftPreview = searchParams.get('cmsPreview') === 'draft' && isPrivilegedCmsAdmin;

  useEffect(() => {
    let cancelled = false;
    if (!wantsDraftPreview) {
      setDraftContent(null);
      return;
    }
    void fetchDraftHomepageCms()
      .then((res) => {
        if (!cancelled) setDraftContent(res.content);
      })
      .catch(() => {
        if (!cancelled) setDraftContent(null);
      });
    return () => {
      cancelled = true;
    };
  }, [wantsDraftPreview]);

  const activeContent = wantsDraftPreview && draftContent ? draftContent : publishedHomepage;

  useEffect(() => {
    if (activeContent.storeName) {
      document.title = activeContent.storeName;
    }
    const safeFavicon = sanitizeCmsImageUrl(activeContent.faviconUrl, '');
    if (safeFavicon) {
      let link = document.querySelector<HTMLLinkElement>("link[rel~='icon']");
      if (!link) {
        link = document.createElement('link');
        link.rel = 'icon';
        document.head.appendChild(link);
      }
      link.href = safeFavicon;
    }
  }, [activeContent.storeName, activeContent.faviconUrl]);

  return (
    <HomepageView
      cmsContent={activeContent}
      levels={displayLevels}
      branches={displayBranches}
      systemSettings={systemSettings}
      memberProfile={memberProfile}
      adminProfile={adminProfile}
      hasUserSession={Boolean(firebaseUser)}
      isPreviewMode={wantsDraftPreview && Boolean(draftContent)}
      previewLabel="Mode Preview Draft CMS — Konten ini hanya terlihat oleh Admin yang terautentikasi dan belum dipublikasikan ke publik."
    />
  );
}
