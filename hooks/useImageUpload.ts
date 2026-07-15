"use client";

import { useState, useCallback } from "react";
import { useToast } from "@/components/ui/Toast";

interface UploadResult {
  url: string;
  markdown: string;
  filename: string;
  size: number;
  type: string;
}

export function useImageUpload() {
  const { notify } = useToast();
  const [isUploading, setIsUploading] = useState(false);

  const upload = useCallback(
    async (file: File): Promise<UploadResult | null> => {
      setIsUploading(true);

      try {
        const formData = new FormData();
        formData.append("image", file);

        const response = await fetch("/api/upload/image", {
          method: "POST",
          body: formData,
        });

        if (!response.ok) {
          const error = await response.json();
          throw new Error(error.error || "Upload failed");
        }

        const result = await response.json();
        notify(`Uploaded "${file.name}"`);
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to upload image";
        notify(message);
        return null;
      } finally {
        setIsUploading(false);
      }
    },
    [notify]
  );

  return {
    upload,
    isUploading,
  };
}
