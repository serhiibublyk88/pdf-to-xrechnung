'use client';

import { useRef, useState } from 'react';
import { uploadInvoice } from '@/lib/api/home-client';
import { describeApiError } from '@/lib/api/error-message';
import { useDictionary } from '@/lib/i18n/dictionary-context';
import type { UploadAcceptedResult } from '@/lib/api/base-schemas';

const MAX_UPLOAD_MB = 10;
const INPUT_ID = 'invoice-upload-input';

export function UploadDropzone({
  onUploaded,
}: {
  onUploaded: (result: UploadAcceptedResult, filename: string) => void;
}) {
  const dictionary = useDictionary();
  const [isDragActive, setIsDragActive] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const uploadInFlightRef = useRef(false);

  async function handleFile(file: File) {
    if (uploadInFlightRef.current) return;
    setError(null);

    if (file.type !== 'application/pdf') {
      setError(dictionary.upload.invalidType);
      return;
    }
    if (file.size > MAX_UPLOAD_MB * 1024 * 1024) {
      setError(dictionary.upload.tooLarge(MAX_UPLOAD_MB));
      return;
    }

    uploadInFlightRef.current = true;
    setIsUploading(true);
    try {
      const uploaded = await uploadInvoice(file);
      if (!uploaded.ok) {
        setError(describeApiError(uploaded.error, dictionary, 'upload'));
        return;
      }
      onUploaded(uploaded.data, file.name);
    } finally {
      uploadInFlightRef.current = false;
      setIsUploading(false);
    }
  }

  function handleDrop(event: React.DragEvent<HTMLLabelElement>) {
    event.preventDefault();
    setIsDragActive(false);
    const file = event.dataTransfer.files[0];
    if (file) void handleFile(file);
  }

  function handleInputChange(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) void handleFile(file);
    event.target.value = '';
  }

  return (
    <div>
      <label
        htmlFor={INPUT_ID}
        aria-busy={isUploading}
        aria-disabled={isUploading}
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragActive(true);
        }}
        onDragLeave={() => setIsDragActive(false)}
        onDrop={handleDrop}
        className={`flex cursor-pointer flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed px-6 py-12 text-center transition-colors focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus-ring ${
          isDragActive
            ? 'border-focus-ring bg-surface-raised'
            : 'border-border bg-surface'
        }`}
      >
        {/* Keep the input name stable; live status announces drag and upload state. */}
        <span className="text-text">{dictionary.upload.dropzoneHint}</span>
        <input
          id={INPUT_ID}
          type="file"
          accept="application/pdf"
          className="sr-only"
          disabled={isUploading}
          onChange={handleInputChange}
        />
      </label>
      <p role="status" className="mt-2 min-h-5 text-sm text-text-muted">
        {isDragActive
          ? dictionary.upload.dropzoneActive
          : isUploading
            ? dictionary.upload.uploading
            : ''}
      </p>
      {error && (
        <p role="alert" className="mt-1 text-sm text-error">
          {error}
        </p>
      )}
    </div>
  );
}
