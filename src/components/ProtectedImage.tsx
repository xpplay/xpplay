import { useEffect, useState } from 'react';
import { ImageOff } from 'lucide-react';
import { auth } from '../lib/firebase.ts';

interface ProtectedImageProps {
  src: string;
  alt: string;
  className?: string;
}

export function ProtectedImage({ src, alt, className = '' }: ProtectedImageProps) {
  const [objectUrl, setObjectUrl] = useState<string>('');
  const [failed, setFailed] = useState<boolean>(false);

  useEffect(() => {
    let active = true;
    let createdUrl = '';
    setFailed(false);
    setObjectUrl('');

    async function load() {
      if (!src) {
        if (active) setFailed(true);
        return;
      }
      if (!src.startsWith('/api/claims/evidence/')) {
        if (active) setObjectUrl(src);
        return;
      }
      try {
        const token = await auth.currentUser?.getIdToken();
        if (!token) {
          setFailed(true);
          return;
        }
        const res = await fetch(src, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          setFailed(true);
          return;
        }
        const blob = await res.blob();
        createdUrl = URL.createObjectURL(blob);
        if (active) {
          setObjectUrl(createdUrl);
        }
      } catch {
        if (active) setFailed(true);
      }
    }

    void load();
    return () => {
      active = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [src]);

  if (failed || !objectUrl) {
    return (
      <div className={`flex flex-col items-center justify-center bg-[#070B19] border border-indigo-500/20 text-slate-400 ${className}`}>
        <ImageOff className="w-5 h-5 mb-1 text-indigo-300/70" />
        <span className="text-[11px] text-center px-1">Bukti tidak tersedia</span>
      </div>
    );
  }

  return (
    <img
      src={objectUrl}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      className={className}
    />
  );
}
