import { describe, expect, it } from 'vitest';
import fs from 'fs';
import {
  DEFAULT_HOMEPAGE_CMS,
  isSafeCmsImageUrl,
  isSafeCmsUrl,
  sanitizeCmsText,
  sanitizeHomepageCmsContent,
  validateCmsSecurity,
} from '../shared/cmsSanitizer.ts';

describe('PHASE A — CMS Homepage Security, Sanitization, Draft/Publish & Rules Tests', () => {
  it('provides safe complete defaults for every required MODULE 1 homepage CMS field', () => {
    const content = sanitizeHomepageCmsContent(undefined);
    expect(content.brandName).toBe('XP PLAY');
    expect(content.storeName).toContain('XP PLAY');
    expect(content.heroTitle.length).toBeGreaterThan(5);
    expect(content.aboutTitle.length).toBeGreaterThan(5);
    expect(content.address.length).toBeGreaterThan(5);
    expect(content.whatsapp.length).toBeGreaterThan(5);
    expect(content.mapsUrl).toMatch(/^https:\/\//);
    expect(content.operatingHours.length).toBeGreaterThan(3);
    expect(content.faqItems.length).toBeGreaterThanOrEqual(1);
    expect(content.footerCopyright).toContain('XP PLAY');
  });

  it('blocks XSS payloads (<script>, javascript:, onerror=, <iframe>, SVG data URIs) on validateCmsSecurity', () => {
    const withScript = {
      ...DEFAULT_HOMEPAGE_CMS,
      heroTitle: 'Promo <script>alert(1)</script>',
    };
    expect(validateCmsSecurity(withScript).valid).toBe(false);

    const withOnError = {
      ...DEFAULT_HOMEPAGE_CMS,
      heroDescription: '<img src=x onerror=alert(1)>',
    };
    expect(validateCmsSecurity(withOnError).valid).toBe(false);

    const withJsUrl = {
      ...DEFAULT_HOMEPAGE_CMS,
      ctaPrimaryUrl: 'javascript:alert(document.cookie)',
    };
    expect(validateCmsSecurity(withJsUrl).valid).toBe(false);

    const withSvgDataImg = {
      ...DEFAULT_HOMEPAGE_CMS,
      heroImageUrl: 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+PC9zdmc+',
    };
    expect(validateCmsSecurity(withSvgDataImg).valid).toBe(false);

    const withProtocolRelative = {
      ...DEFAULT_HOMEPAGE_CMS,
      ctaSecondaryUrl: '//evil.example.com/phish',
    };
    expect(validateCmsSecurity(withProtocolRelative).valid).toBe(false);

    const withFaqScript = {
      ...DEFAULT_HOMEPAGE_CMS,
      faqItems: [
        {
          id: 'faq_xss',
          question: 'Normal?',
          answer: '<iframe src="https://evil.test"></iframe>',
        },
      ],
    };
    expect(validateCmsSecurity(withFaqScript).valid).toBe(false);
  });

  it('strips dangerous HTML markup on sanitizeCmsText & sanitizeHomepageCmsContent defense-in-depth', () => {
    expect(sanitizeCmsText('<b>XP PLAY</b><script>evil()</script> Demang', 100)).toBe(
      'XP PLAY Demang'
    );
    const cleaned = sanitizeHomepageCmsContent({
      brandName: '<b>XP PLAY</b>',
      ctaPrimaryUrl: 'javascript:alert(1)',
      heroImageUrl: 'data:text/html,<script>alert(1)</script>',
    });
    expect(cleaned.brandName).toBe('XP PLAY');
    expect(cleaned.ctaPrimaryUrl).toBe(DEFAULT_HOMEPAGE_CMS.ctaPrimaryUrl);
    expect(cleaned.heroImageUrl).toBe('');
  });

  it('allows safe navigation and CMS uploaded asset URLs', () => {
    expect(isSafeCmsUrl('/register')).toBe(true);
    expect(isSafeCmsUrl('#cabang')).toBe(true);
    expect(isSafeCmsUrl('https://instagram.com/xpplay')).toBe(true);
    expect(isSafeCmsUrl('javascript:void(0)')).toBe(false);

    expect(isSafeCmsImageUrl('/api/cms/assets/cms_1700000_abcdef.png')).toBe(true);
    expect(isSafeCmsImageUrl('https://cdn.xpplay.id/hero.webp')).toBe(true);
    expect(isSafeCmsImageUrl('data:image/svg+xml,<svg/>')).toBe(false);
  });

  it('enforces CMS draft/published/immutable version isolation & RBAC in firestore.rules and API routes', () => {
    const rules = fs.readFileSync('firestore.rules', 'utf8');
    // Public can only read published homepage document, never list or write
    expect(rules).toContain('match /cmsPublished/{docId}');
    expect(rules).toContain("allow get: if docId == 'homepage';");
    expect(rules).toContain("allow create, update: if docId == 'homepage' && isValidCmsPublished(incoming())");
    expect(rules).toContain('(isFullAdminOrSuper() && !isSystemRestoreLocked())');

    // Drafts isolated strictly to admins, writable only by ADMIN or SUPER_ADMIN
    expect(rules).toContain('match /cmsDrafts/{docId}');
    expect(rules).toContain("allow get: if docId == 'homepage' && isAdmin();");
    expect(rules).toContain("allow create, update: if docId == 'homepage' && isValidCmsDraft(incoming())");

    // Version history immutable outside SUPER_ADMIN restore lock
    expect(rules).toContain('match /cmsVersions/{versionId}');
    expect(rules).toContain(
      'allow create: if isValidId(versionId) && isValidCmsVersion(incoming()) && incoming().versionId == versionId'
    );
    expect(rules).toContain('allow update, delete: if false;');

    // Backend asset upload restricted to SUPER_ADMIN & ADMIN + magic bytes check
    const apiCode = fs.readFileSync('src/server/routes/api.ts', 'utf8');
    expect(apiCode).toContain("'/admin/cms/assets'");
    expect(apiCode).toContain("requireAdminRole(['SUPER_ADMIN', 'ADMIN'])");
    expect(apiCode).toContain('hasValidImageMagicBytes');
  });
});
