'use client';

import { useEffect, useState } from 'react';
import { getExtractionMode } from '@/lib/api/extraction-mode-client';
import { useDictionary } from '@/lib/i18n/dictionary-context';

export function DemoModeNotice() {
  const dictionary = useDictionary();
  const [demo, setDemo] = useState(false);

  useEffect(() => {
    let active = true;
    void getExtractionMode().then((mode) => {
      if (active && mode.ok) setDemo(mode.data.demo);
    });
    return () => {
      active = false;
    };
  }, []);

  if (!demo) return null;
  return (
    <p className="border-b border-warning bg-warning-bg px-6 py-2 text-sm text-warning">
      {dictionary.demoNotice}
    </p>
  );
}
