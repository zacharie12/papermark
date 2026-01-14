import { get } from "@vercel/edge-config";
import { parsePageId } from "notion-utils";

import { DocumentData } from "@/lib/documents/create-document";
import { copyFileToBucketServer } from "@/lib/files/copy-file-to-bucket-server";
import notion from "@/lib/notion";
import { getNotionPageIdFromSlug } from "@/lib/notion/utils";
import prisma from "@/lib/prisma";
import {
  convertCadToPdfTask,
  convertFilesToPdfTask,
  convertKeynoteToPdfTask,
} from "@/lib/trigger/convert-files";
import { processVideo } from "@/lib/trigger/optimize-video-files";
import { convertPdfToImageRoute } from "@/lib/trigger/pdf-to-image-route";
import { getExtension, log } from "@/lib/utils";
import { conversionQueue } from "@/lib/utils/trigger-utils";
import { sendDocumentCreatedWebhook } from "@/lib/webhook/triggers/document-created";
import { sendLinkCreatedWebhook } from "@/lib/webhook/triggers/link-created";

type ProcessDocumentParams = {
  documentData: DocumentData;
  teamId: string;
  teamPlan: string;
  userId?: string;
  folderPathName?: string;
  createLink?: boolean;
  isExternalUpload?: boolean;
};

export const processDocument = async ({
  documentData,
  teamId,
  teamPlan,
  userId,
  folderPathName,
  createLink = false,
  isExternalUpload = false,
}: ProcessDocumentParams) => {
  const {
    name,
    key,
    storageType,
    contentType,
    supportedFileType,
    fileSize,
    numPages,
    enableExcelAdvancedMode,
  } = documentData;

  // Get passed type property or alternatively, the file extension and save it as the type
  const type = supportedFileType || getExtension(name);

  // Check whether the Notion page is publically accessible or not
  if (type === "notion") {
    try {
      let pageId = parsePageId(key, { uuid: false });

      // If parsePageId fails, try to get page ID from slug
      if (!pageId) {
        try {
          const pageIdFromSlug = await getNotionPageIdFromSlug(key);
          pageId = pageIdFromSlug || undefined;
        } catch (slugError) {
          console.error("Notion slug error (non-fatal):", slugError);
          // Don't throw here, let the next check handle it or fail gracefully
        }
      }

      // if the page isn't accessible then end the process here.
      if (!pageId) {
        // Only throw if we strictly cannot proceed with Notion
        throw new Error("Notion page not found");
      }
      await notion.getPage(pageId);
    } catch (error) {
      // Allow Notion validation to block only if it's strictly a notion import
      throw new Error("This Notion page isn't publically available.");
    }
  }

  // For link type, validate URL format
  if (type === "link") {
    try {
      new URL(key);

      // Wrap Edge Config in try-catch so it doesn't block uploads if Vercel Config is down/missing
      try {
        const keywords = await get("keywords");
        if (Array.isArray(keywords) && keywords.length > 0) {
          const matchedKeyword = keywords.find(
            (keyword) => typeof keyword === "string" && key.includes(keyword),
          );

          if (matchedKeyword) {
            log({
              message: `Link document creation blocked: ${matchedKeyword} \n\n \`Metadata: {teamId: ${teamId}, url: ${key}}\``,
              type: "error",
              mention: true,
            });
            throw new Error("This URL is not allowed");
          }
        }
      } catch (edgeError) {
        console.warn("Edge config check failed (ignored):", edgeError);
      }
    } catch (error) {
      if (error instanceof Error && error.message === "This URL is not allowed") {
        throw error;
      }
      throw new Error("Invalid URL format for link document.");
    }
  }

  // 1. Resolve Folder (Safe)
  let folderId = null;
  try {
    const folder = await prisma.folder.findUnique({
      where: {
        teamId_path: {
          teamId,
          path: "/" + folderPathName,
        },
      },
      select: {
        id: true,
      },
    });
    folderId = folder?.id ?? null;
  } catch (e) {
    console.error("Folder lookup failed (defaulting to root):", e);
  }

  // determine if the document is download only
  const isDownloadOnly =
    type === "zip" ||
    type === "map" ||
    type === "email" ||
    contentType === "text/tab-separated-values";

  // 2. CRITICAL STEP: Save to Database
  // If this succeeds, we return the document no matter what happens next.
  const document = await prisma.document.create({
    data: {
      name: name,
      numPages: numPages,
      file: key,
      originalFile: key,
      contentType: contentType,
      type: type,
      storageType,
      ownerId: userId,
      teamId: teamId,
      advancedExcelEnabled: enableExcelAdvancedMode,
      downloadOnly: isDownloadOnly,
      ...(createLink && {
        links: {
          create: {
            teamId,
          },
        },
      }),
      versions: {
        create: {
          file: key,
          originalFile: key,
          contentType: contentType,
          type: type,
          storageType,
          numPages: numPages,
          isPrimary: true,
          versionNumber: 1,
          fileSize: fileSize,
        },
      },
      folderId: folderId,
      isExternalUpload,
    },
    include: {
      links: true,
      versions: true,
    },
  });

  // 3. Background Jobs (Wrapped in Try/Catch to prevent 500 Errors)
  try {
    const taskOptions = {
      idempotencyKey: `${teamId}-${document.versions[0].id}`,
      tags: [
        `team_${teamId}`,
        `document_${document.id}`,
        `version:${document.versions[0].id}`,
      ],
      queue: conversionQueue(teamPlan),
      concurrencyKey: teamId,
    };

    if (
      type === "slides" &&
      (contentType === "application/vnd.apple.keynote" ||
        contentType === "application/x-iwork-keynote-sffkey")
    ) {
      await convertKeynoteToPdfTask.trigger(
        {
          documentId: document.id,
          documentVersionId: document.versions[0].id,
          teamId,
        },
        { ...taskOptions, idempotencyKey: `${taskOptions.idempotencyKey}-keynote` }
      );
    } else if (type === "docs" || type === "slides") {
      await convertFilesToPdfTask.trigger(
        {
          documentId: document.id,
          documentVersionId: document.versions[0].id,
          teamId,
        },
        { ...taskOptions, idempotencyKey: `${taskOptions.idempotencyKey}-docs` }
      );
    }

    if (type === "cad") {
      await convertCadToPdfTask.trigger(
        {
          documentId: document.id,
          documentVersionId: document.versions[0].id,
          teamId,
        },
        { ...taskOptions, idempotencyKey: `${taskOptions.idempotencyKey}-cad` }
      );
    }

    if (
      type === "video" &&
      contentType !== "video/mp4" &&
      contentType?.startsWith("video/")
    ) {
      await processVideo.trigger(
        {
          videoUrl: key,
          teamId,
          docId: key.split("/")[1],
          documentVersionId: document.versions[0].id,
          fileSize: fileSize || 0,
        },
        taskOptions
      );
    }

    // skip triggering convert-pdf-to-image job for "notion" / "excel" documents
    if (type === "pdf") {
      await convertPdfToImageRoute.trigger(
        {
          documentId: document.id,
          documentVersionId: document.versions[0].id,
          teamId,
        },
        taskOptions
      );
    }
  } catch (error) {
    // IMPORTANT: We log the error but DO NOT throw it. 
    // This allows the upload to finish even if QStash/Conversion fails.
    console.error("Background job trigger failed (non-fatal):", error);
  }

  // 4. Advanced Excel Mode (Wrapped)
  if (type === "sheet" && enableExcelAdvancedMode) {
    try {
      await copyFileToBucketServer({
        filePath: document.versions[0].file,
        storageType: document.versions[0].storageType,
        teamId,
      });

      await prisma.documentVersion.update({
        where: { id: document.versions[0].id },
        data: { numPages: 1 },
      });

      if (process.env.NEXTAUTH_URL && process.env.REVALIDATE_TOKEN) {
        await fetch(
          `${process.env.NEXTAUTH_URL}/api/revalidate?secret=${process.env.REVALIDATE_TOKEN}&documentId=${document.id}`,
        ).catch(e => console.error("Revalidate fetch error:", e));
      }
    } catch (e) {
      console.error("Excel advanced mode failed:", e);
    }
  }

  // 5. Webhooks & Slack Integrations (Wrapped)
  // This is where the "Slack environment variable" error likely originates.
  // By wrapping this, we ensure the user still sees their file even if Slack fails.
  try {
    await Promise.all([
      !isExternalUpload &&
        sendDocumentCreatedWebhook({
          teamId,
          data: {
            document_id: document.id,
          },
        }).catch(e => console.error("Document Webhook failed:", e)),
      createLink &&
        sendLinkCreatedWebhook({
          teamId,
          data: {
            document_id: document.id,
            link_id: document.links[0]?.id,
          },
        }).catch(e => console.error("Link Webhook failed:", e)),
    ]);
  } catch (error) {
    console.error("Webhook/Integration error (non-fatal):", error);
  }

  return document;
};
