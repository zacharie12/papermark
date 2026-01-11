import { useRouter } from "next/router";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { useTeam } from "@/context/team-context";
import { DocumentStorageType } from "@prisma/client";
import { useSession } from "next-auth/react";
import { DropEvent, FileRejection, useDropzone } from "react-dropzone";
import { toast } from "sonner";
import { mutate } from "swr";
import { upload as vercelUpload } from "@vercel/blob/client";

import { useAnalytics } from "@/lib/analytics";
import {
  FREE_PLAN_ACCEPTED_FILE_TYPES,
  FULL_PLAN_ACCEPTED_FILE_TYPES,
  SUPPORTED_DOCUMENT_MIME_TYPES,
} from "@/lib/constants";
import { DocumentData, createDocument } from "@/lib/documents/create-document";
import { resumableUpload } from "@/lib/files/tus-upload";
import {
  createFolderInBoth,
  createFolderInMainDocs,
  determineFolderPaths,
  isSystemFile,
} from "@/lib/folders/create-folder";
import { usePlan } from "@/lib/swr/use-billing";
import useLimits from "@/lib/swr/use-limits";
import { useTeamSettings } from "@/lib/swr/use-team-settings";
import { CustomUser } from "@/lib/types";
import { cn } from "@/lib/utils";
import { getSupportedContentType } from "@/lib/utils/get-content-type";
import {
  getFileSizeLimit,
  getFileSizeLimits,
} from "@/lib/utils/get-file-size-limits";
import { getPagesCount } from "@/lib/utils/get-page-number-count";

const acceptableDropZoneMimeTypesWhenIsFreePlanAndNotTrial =
  FREE_PLAN_ACCEPTED_FILE_TYPES;
const allAcceptableDropZoneMimeTypes = FULL_PLAN_ACCEPTED_FILE_TYPES;

interface FileWithPaths extends File {
  path?: string;
  whereToUploadPath?: string;
  dataroomUploadPath?: string;
}

export interface UploadState {
  fileName: string;
  progress: number;
  documentId?: string;
  uploadId: string;
}

export interface RejectedFile {
  fileName: string;
  message: string;
}

interface UploadZoneProps extends React.PropsWithChildren {
  onUploadStart: (uploads: UploadState[]) => void;
  onUploadProgress: (
    index: number,
    progress: number,
    documentId?: string,
  ) => void;
  onUploadRejected: (rejected: RejectedFile[]) => void;
  onUploadSuccess?: (
    files: {
      fileName: string;
      documentId: string;
      dataroomDocumentId: string;
    }[],
  ) => void;
  setUploads: React.Dispatch<React.SetStateAction<UploadState[]>>;
  setRejectedFiles: React.Dispatch<React.SetStateAction<RejectedFile[]>>;
  folderPathName?: string;
  dataroomId?: string;
  dataroomName?: string;
}

export default function UploadZone({
  children,
  onUploadStart,
  onUploadProgress,
  onUploadRejected,
  onUploadSuccess,
  folderPathName,
  setUploads,
  setRejectedFiles,
  dataroomId,
  dataroomName,
}: UploadZoneProps) {
  const analytics = useAnalytics();
  const { plan, isFree, isTrial } = usePlan();
  const router = useRouter();
  const teamInfo = useTeam();
  const { data: session } = useSession();
  const { limits, canAddDocuments, isPaused } = useLimits();
  const remainingDocuments = limits?.documents
    ? limits?.documents - limits?.usage?.documents
    : 0;

  const { settings: teamSettings } = useTeamSettings(teamInfo?.currentTeam?.id);
  const replicateDataroomFolders =
    teamSettings?.replicateDataroomFolders ?? true;

  const dataroomFolderPathRef = useRef<string | null>(null);
  const dataroomFolderCreationPromiseRef = useRef<Promise<string> | null>(null);

  useEffect(() => {
    dataroomFolderPathRef.current = null;
    dataroomFolderCreationPromiseRef.current = null;
  }, [replicateDataroomFolders, dataroomId]);

  const fileSizeLimits = useMemo(
    () =>
      getFileSizeLimits({
        limits,
        isFree,
        isTrial,
      }),
    [limits, isFree, isTrial],
  );

  const acceptableDropZoneFileTypes =
    isFree && !isTrial
      ? acceptableDropZoneMimeTypesWhenIsFreePlanAndNotTrial
      : allAcceptableDropZoneMimeTypes;

  const getOrCreateDataroomFolder = useCallback(async (): Promise<string> => {
    if (dataroomFolderPathRef.current) {
      return dataroomFolderPathRef.current;
    }

    if (dataroomFolderCreationPromiseRef.current) {
      return dataroomFolderCreationPromiseRef.current;
    }

    const creationPromise = (async () => {
      try {
        if (!teamInfo?.currentTeam?.id || !dataroomName) {
          throw new Error("Missing team ID or dataroom name");
        }

        const existingFoldersResponse = await fetch(
          `/api/teams/${teamInfo.currentTeam.id}/folders?root=true`,
        );

        if (existingFoldersResponse.ok) {
          const existingFolders = await existingFoldersResponse.json();
          const existingDataroomFolder = existingFolders.find(
            (folder: any) => folder.name === dataroomName,
          );

          if (existingDataroomFolder) {
            const folderPath = existingDataroomFolder.path.startsWith("/")
              ? existingDataroomFolder.path.slice(1)
              : existingDataroomFolder.path;
            dataroomFolderPathRef.current = folderPath;
            return folderPath;
          }
        }

        const dataroomFolderResponse = await createFolderInMainDocs({
          teamId: teamInfo.currentTeam.id,
          name: dataroomName,
          path: undefined,
        });

        const folderPath = dataroomFolderResponse.path.startsWith("/")
          ? dataroomFolderResponse.path.slice(1)
          : dataroomFolderResponse.path;

        dataroomFolderPathRef.current = folderPath;

        analytics.capture("Dataroom Folder Created in Main Docs", {
          folderName: dataroomName,
          dataroomId,
        });

        return folderPath;
      } catch (error) {
        console.error("Error handling dataroom folder:", error);
        dataroomFolderCreationPromiseRef.current = null;
        const fallbackPath = dataroomName || "";
        dataroomFolderPathRef.current = fallbackPath;
        return fallbackPath;
      } finally {
        dataroomFolderCreationPromiseRef.current = null;
      }
    })();

    dataroomFolderCreationPromiseRef.current = creationPromise;
    return creationPromise;
  }, [teamInfo, dataroomName, dataroomId, analytics]);

  const endpointTargetType = dataroomId
    ? `datarooms/${dataroomId}/folders`
    : "folders";

  const onDropRejected = useCallback(
    (rejectedFiles: FileRejection[]) => {
      const rejected = rejectedFiles.map(({ file, errors }) => {
        let message = "";
        if (errors.find(({ code }) => code === "file-too-large")) {
          const fileSizeLimitMB = getFileSizeLimit(file.type, fileSizeLimits);
          message = `File size too big (max. ${fileSizeLimitMB} MB). Upgrade to a paid plan to increase the limit.`;
        } else if (errors.find(({ code }) => code === "file-invalid-type")) {
          const isSupported = SUPPORTED_DOCUMENT_MIME_TYPES.includes(file.type);
          message = `File type not supported ${
            isFree && !isTrial && isSupported ? `on free plan` : ""
          }`;
        }
        return { fileName: file.name, message };
      });
      onUploadRejected(rejected);
    },
    [onUploadRejected, fileSizeLimits, isFree, isTrial],
  );

  const onDrop = useCallback(
    async (acceptedFiles: FileWithPaths[]) => {
      if (isPaused) {
        toast.error(
          "Your subscription is paused. Resume your subscription to upload documents.",
          {
            action: {
              label: "Go to Billing",
              onClick: () => router.push("/settings/billing"),
            },
          },
        );
        return;
      }

      if (!canAddDocuments && acceptedFiles.length > remainingDocuments) {
        toast.error("You have reached the maximum number of documents.");
        return;
      }

      const validatedFiles = acceptedFiles.reduce<{
        valid: FileWithPaths[];
        invalid: { fileName: string; message: string }[];
      }>(
        (acc, file) => {
          const fileSizeLimitMB = getFileSizeLimit(file.type, fileSizeLimits);
          const fileSizeLimit = fileSizeLimitMB * 1024 * 1024;

          if (file.size > fileSizeLimit) {
            acc.invalid.push({
              fileName: file.name,
              message: `File size too big (max. ${fileSizeLimitMB} MB)${
                isFree && !isTrial
                  ? ". Upgrade to a paid plan to increase the limit"
                  : ""
              }`,
            });
          } else {
            acc.valid.push(file);
          }
          return acc;
        },
        { valid: [], invalid: [] },
      );

      if (validatedFiles.invalid.length > 0) {
        setRejectedFiles((prev) => [...validatedFiles.invalid, ...prev]);

        if (validatedFiles.valid.length === 0) {
          toast.error(
            `${validatedFiles.invalid.length} file(s) exceeded size limits`,
          );
          return;
        }
      }

      const newUploads = validatedFiles.valid.map((file) => ({
        fileName: file.name,
        progress: 0,
        uploadId: crypto.randomUUID(),
      }));

      onUploadStart(newUploads);

      const uploadPromises = validatedFiles.valid.map(async (file, index) => {
        const path = file.path || file.name;

        let numPages = 1;
        if (file.type === "application/pdf") {
          const buffer = await file.arrayBuffer();
          numPages = await getPagesCount(buffer);

          if (numPages > fileSizeLimits.maxPages) {
            setUploads((prev) =>
              prev.filter((upload) => upload.fileName !== file.name),
            );

            return setRejectedFiles((prev) => [
              {
                fileName: file.name,
                message: `File has too many pages (max. ${fileSizeLimits.maxPages})`,
              },
              ...prev,
            ]);
          }
        }

        // --- UPLOAD LOGIC START ---
        // Determined by Environment Variable (defaulting to "tus")
        const uploadTransport =
          process.env.NEXT_PUBLIC_UPLOAD_TRANSPORT || "tus";
        let complete;

        if (uploadTransport === "vercel") {
          // Vercel Blob Upload
          const uploadPromise = vercelUpload(path, file, {
            access: "public",
            handleUploadUrl: "/api/file/upload", // Ensure this route exists
            addRandomSuffix: true, // <--- Added random suffix to prevent duplicates
            onUploadProgress: ({ percentage }) => {
              const progress = Math.min(Math.round(percentage), 99);
              setUploads((prevUploads) => {
                const updatedUploads = prevUploads.map((upload) =>
                  upload.uploadId === newUploads[index].uploadId
                    ? { ...upload, progress }
                    : upload,
                );
                const currentUpload = updatedUploads.find(
                  (upload) => upload.uploadId === newUploads[index].uploadId,
                );
                onUploadProgress(index, progress, currentUpload?.documentId);
                return updatedUploads;
              });
            },
          });

          complete = uploadPromise
            .then((blob) => ({
              id: blob.url,
              fileType: blob.contentType || file.type,
              fileName: file.name,
              numPages,
            }))
            .catch((error) => {
              console.error("Vercel Upload Error:", error);
              setUploads((prev) =>
                prev.filter(
                  (upload) => upload.uploadId !== newUploads[index].uploadId,
                ),
              );
              setRejectedFiles((prev) => [
                { fileName: file.name, message: "Error uploading file" },
                ...prev,
              ]);
              throw error;
            });
        } else {
          // Default TUS Upload
          const res = await resumableUpload({
            file,
            onProgress: (bytesUploaded, bytesTotal) => {
              const progress = Math.min(
                Math.round((bytesUploaded / bytesTotal) * 100),
                99,
              );
              setUploads((prevUploads) => {
                const updatedUploads = prevUploads.map((upload) =>
                  upload.uploadId === newUploads[index].uploadId
                    ? { ...upload, progress }
                    : upload,
                );
                const currentUpload = updatedUploads.find(
                  (upload) => upload.uploadId === newUploads[index].uploadId,
                );

                onUploadProgress(index, progress, currentUpload?.documentId);
                return updatedUploads;
              });
            },
            onError: (error) => {
              setUploads((prev) =>
                prev.filter(
                  (upload) => upload.uploadId !== newUploads[index].uploadId,
                ),
              );

              setRejectedFiles((prev) => [
                { fileName: file.name, message: "Error uploading file" },
                ...prev,
              ]);
            },
            ownerId: (session?.user as CustomUser).id,
            teamId: teamInfo?.currentTeam?.id as string,
            numPages,
            relativePath: path.substring(0, path.lastIndexOf("/")),
          });
          complete = res.complete;
        }

        const uploadResult = await complete;
        // --- UPLOAD LOGIC END ---

        let contentType = uploadResult.fileType;
        let supportedFileType = getSupportedContentType(contentType) ?? "";

        if (
          uploadResult.fileName.endsWith(".dwg") ||
          uploadResult.fileName.endsWith(".dxf")
        ) {
          supportedFileType = "cad";
          contentType = `image/vnd.${uploadResult.fileName.split(".").pop()}`;
        }

        if (uploadResult.fileName.endsWith(".xlsm")) {
          supportedFileType = "sheet";
          contentType = "application/vnd.ms-excel.sheet.macroEnabled.12";
        }

        if (
          uploadResult.fileName.endsWith(".kml") ||
          uploadResult.fileName.endsWith(".kmz")
        ) {
          supportedFileType = "map";
          contentType = `application/vnd.google-earth.${uploadResult.fileName.endsWith(".kml") ? "kml+xml" : "kmz"}`;
        }

        const documentData: DocumentData = {
          key: uploadResult.id,
          supportedFileType: supportedFileType,
          name: file.name,
          // FIX: dynamically set the storage type based on the transport used
          storageType: (uploadTransport === "vercel"
            ? "VERCEL_BLOB"
            : DocumentStorageType.S3_PATH) as any,
          contentType: contentType,
          fileSize: file.size,
        };

        const fileUploadPathName = file?.whereToUploadPath;
        const dataroomUploadPathName = file?.dataroomUploadPath;

        const response = await createDocument({
          documentData,
          teamId: teamInfo?.currentTeam?.id as string,
          numPages: uploadResult.numPages,
          folderPathName: fileUploadPathName,
        });

        mutate(`/api/teams/${teamInfo?.currentTeam?.id}/documents`);

        fileUploadPathName &&
          mutate(
            `/api/teams/${teamInfo?.currentTeam?.id}/folders/documents/${fileUploadPathName}`,
          );

        const document = await response.json();
        let dataroomResponse;
        if (dataroomId) {
          try {
            dataroomResponse = await fetch(
              `/api/teams/${teamInfo?.currentTeam?.id}/datarooms/${dataroomId}/documents`,
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({
                  documentId: document.id,
                  folderPathName:
                    dataroomUploadPathName || fileUploadPathName,
                }),
              },
            );

            if (!dataroomResponse?.ok) {
              const { message } = await dataroomResponse.json();
              console.error(
                "An error occurred while adding document to the dataroom: ",
                message,
              );
              return;
            }

            mutate(
              `/api/teams/${teamInfo?.currentTeam?.id}/datarooms/${dataroomId}/documents`,
            );
            (dataroomUploadPathName || fileUploadPathName) &&
              mutate(
                `/api/teams/${teamInfo?.currentTeam?.id}/datarooms/${dataroomId}/folders/documents/${dataroomUploadPathName || fileUploadPathName}`,
              );
          } catch (error) {
            console.error(
              "An error occurred while adding document to the dataroom: ",
              error,
            );
          }
        }

        setUploads((prevUploads) =>
          prevUploads.map((upload) =>
            upload.uploadId === newUploads[index].uploadId
              ? { ...upload, progress: 100, documentId: document.id }
              : upload,
          ),
        );

        analytics.capture("Document Added", {
          documentId: document.id,
          name: document.name,
          numPages: document.numPages,
          path: router.asPath,
          type: document.type,
          contentType: document.contentType,
          teamId: teamInfo?.currentTeam?.id,
          bulkupload: true,
          dataroomId: dataroomId,
          $set: {
            teamId: teamInfo?.currentTeam?.id,
            teamPlan: plan,
          },
        });
        const dataroomDocumentId = dataroomResponse?.ok
          ? (await dataroomResponse.json()).id
          : null;

        return { ...document, dataroomDocumentId: dataroomDocumentId };
      });

      const documents = Promise.all(uploadPromises).finally(() => {
        mutate(
          `/api/teams/${teamInfo?.currentTeam?.id}/${endpointTargetType}?root=true`,
        );
        mutate(
          `/api/teams/${teamInfo?.currentTeam?.id}/${endpointTargetType}`,
        );
        folderPathName &&
          mutate(
            `/api/teams/${teamInfo?.currentTeam?.id}/${endpointTargetType}/${folderPathName}`,
          );
      });
      const uploadedDocuments = await documents;
      const dataroomDocuments = uploadedDocuments.map((document) => ({
        documentId: document.id,
        dataroomDocumentId: document.dataroomDocumentId,
        fileName: document.name,
      }));
      onUploadSuccess?.(dataroomDocuments);
    },
    [
      onUploadStart,
      onUploadProgress,
      endpointTargetType,
      fileSizeLimits,
      isFree,
      isTrial,
      isPaused,
    ],
  );

  const getFilesFromEvent = useCallback(
    async (event: DropEvent) => {
      if (
        "type" in event &&
        event.type !== "drop" &&
        event.type !== "change"
      ) {
        return [];
      }

      let filesToBePassedToOnDrop: FileWithPaths[] = [];

      const traverseFolder = async (
        entry: FileSystemEntry,
        parentPathOfThisEntry?: string,
        dataroomParentPath?: string,
      ): Promise<FileWithPaths[]> => {
        let files: FileWithPaths[] = [];

        if (isSystemFile(entry.name)) {
          return files;
        }

        if (entry.isDirectory) {
          try {
            if (entry.name.trim() === "") {
              setRejectedFiles((prev) => [
                {
                  fileName: entry.name,
                  message: "Folder name cannot be empty",
                },
                ...prev,
              ]);
              throw new Error("Folder name cannot be empty");
            }

            if (!teamInfo?.currentTeam?.id) {
              setRejectedFiles((prev) => [
                {
                  fileName: "Unknown Team",
                  message: "Team Id not found",
                },
                ...prev,
              ]);
              throw new Error("No team found");
            }

            if (!dataroomId) {
              const { path: folderPath } = await createFolderInMainDocs({
                teamId: teamInfo.currentTeam.id,
                name: entry.name,
                path: parentPathOfThisEntry ?? folderPathName,
              });

              analytics.capture("Folder Added", { folderName: entry.name });

              const dirReader = (
                entry as FileSystemDirectoryEntry
              ).createReader();
              const subEntries = await new Promise<FileSystemEntry[]>(
                (resolve) => dirReader.readEntries(resolve),
              );

              const filteredSubEntries = subEntries.filter(
                (subEntry) => !isSystemFile(subEntry.name),
              );

              const resolvedFolderPath = folderPath.startsWith("/")
                ? folderPath.slice(1)
                : folderPath;

              for (const subEntry of filteredSubEntries) {
                files.push(
                  ...(await traverseFolder(
                    subEntry,
                    resolvedFolderPath,
                    undefined,
                  )),
                );
              }
            } else {
              const isFirstLevelFolder =
                (parentPathOfThisEntry ?? folderPathName) === folderPathName;

              const {
                parentDataroomPath: targetParentDataroomPath,
                parentMainDocsPath: targetParentMainDocsPath,
              } = determineFolderPaths({
                currentDataroomPath: dataroomParentPath ?? folderPathName,
                currentMainDocsPath: parentPathOfThisEntry,
                isFirstLevelFolder,
              });

              if (!replicateDataroomFolders && dataroomName) {
                await getOrCreateDataroomFolder();
              }

              const { dataroomPath, mainDocsPath } = await createFolderInBoth({
                teamId: teamInfo.currentTeam.id,
                dataroomId,
                name: entry.name,
                parentMainDocsPath: targetParentMainDocsPath,
                parentDataroomPath: targetParentDataroomPath,
                setRejectedFiles,
                analytics,
                replicateDataroomFolders,
              });

              const dirReader = (
                entry as FileSystemDirectoryEntry
              ).createReader();
              const subEntries = await new Promise<FileSystemEntry[]>(
                (resolve) => dirReader.readEntries(resolve),
              );

              const filteredSubEntries = subEntries.filter(
                (subEntry) => !isSystemFile(subEntry.name),
              );

              const resolvedMainDocsPath = mainDocsPath
                ? mainDocsPath.startsWith("/")
                  ? mainDocsPath.slice(1)
                  : mainDocsPath
                : undefined;
              const resolvedDataroomPath = dataroomPath.startsWith("/")
                ? dataroomPath.slice(1)
                : dataroomPath;

              for (const subEntry of filteredSubEntries) {
                files.push(
                  ...(await traverseFolder(
                    subEntry,
                    resolvedMainDocsPath,
                    resolvedDataroomPath,
                  )),
                );
              }
            }
          } catch (error) {
            console.error(
              "An error occurred while creating the folder: ",
              error,
            );
            setRejectedFiles((prev) => [
              {
                fileName: entry.name,
                message: "Failed to create the folder",
              },
              ...prev,
            ]);
          }
        } else if (entry.isFile) {
          if (isSystemFile(entry.name)) {
            return files;
          }

          let file = await new Promise<FileWithPaths>((resolve) =>
            (entry as FileSystemFileEntry).file(resolve),
          );

          const browserFileTypeCompatibilityIssue = file.type === "";

          if (browserFileTypeCompatibilityIssue) {
            const fileExtension = file.name.split(".").pop()?.toLowerCase();
            let correctMimeType: string | undefined;
            if (fileExtension) {
              for (const [mime, extsUntyped] of Object.entries(
                acceptableDropZoneFileTypes,
              )) {
                const exts = extsUntyped as string[];
                if (
                  exts.some(
                    (ext) => ext.toLowerCase() === "." + fileExtension,
                  )
                ) {
                  correctMimeType = mime;
                  break;
                }
              }
            }

            if (correctMimeType) {
              file = new File([file], file.name, {
                type: correctMimeType,
                lastModified: file.lastModified,
              });
            }
          }

          file.path = entry.fullPath.startsWith("/")
            ? entry.fullPath.substring(1)
            : entry.fullPath;

          if (!replicateDataroomFolders && dataroomId && dataroomName) {
            const dataroomFolderPath = await getOrCreateDataroomFolder();
            file.whereToUploadPath = dataroomFolderPath;
          } else {
            file.whereToUploadPath = parentPathOfThisEntry ?? folderPathName;
          }

          file.dataroomUploadPath = dataroomParentPath;

          files.push(file);
        }

        return files;
      };

      if ("dataTransfer" in event && event.dataTransfer) {
        const items = event.dataTransfer.items;

        const fileResults = await Promise.all(
          Array.from(items, (item) => {
            const entry =
              (typeof item?.webkitGetAsEntry === "function" &&
                item.webkitGetAsEntry()) ??
              (typeof (item as any)?.getAsEntry === "function" &&
                (item as any).getAsEntry()) ??
              null;
            return entry
              ? traverseFolder(
                  entry,
                  folderPathName,
                  dataroomId ? folderPathName : undefined,
                )
              : [];
          }),
        );
        fileResults.forEach((fileResult) =>
          filesToBePassedToOnDrop.push(...fileResult),
        );
      } else if (
        "target" in event &&
        event.target &&
        event.target instanceof HTMLInputElement &&
        event.target.files
      ) {
        for (let i = 0; i < event.target.files.length; i++) {
          const file: FileWithPaths = event.target.files[i];
          file.path = file.name;
          file.whereToUploadPath = folderPathName;
          file.dataroomUploadPath = folderPathName;
          filesToBePassedToOnDrop.push(event.target.files[i]);
        }
      }

      return filesToBePassedToOnDrop;
    },
    [
      folderPathName,
      endpointTargetType,
      teamInfo,
      dataroomId,
      dataroomName,
      analytics,
      setRejectedFiles,
      acceptableDropZoneFileTypes,
      getOrCreateDataroomFolder,
    ],
  );

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    accept: acceptableDropZoneFileTypes,
    multiple: true,
    maxFiles: fileSizeLimits.maxFiles ?? 150,
    onDrop,
    onDropRejected,
    getFilesFromEvent,
  });

  return (
    <div
      {...getRootProps({ onClick: (evt) => evt.stopPropagation() })}
      className={cn(
        "relative",
        dataroomId ? "min-h-[calc(100vh-350px)]" : "min-h-[calc(100vh-270px)]",
      )}
    >
      <div
        className={cn(
          "absolute inset-0 z-40 -m-1 rounded-lg border-2 border-dashed",
          isDragActive
            ? "pointer-events-auto border-primary/50 bg-gray-100/75 backdrop-blur-sm dark:bg-gray-800/75"
            : "pointer-events-none border-none",
        )}
      >
        <input
          {...getInputProps()}
          name="file"
          id="upload-multi-files-zone"
          className="sr-only"
        />

        {isDragActive && (
          <div className="sticky top-1/2 z-50 -translate-y-1/2 px-2">
            <div className="flex justify-center">
              <div className="inline-flex flex-col rounded-lg bg-background/95 px-6 py-4 text-center ring-1 ring-gray-900/5 dark:bg-gray-900/95 dark:ring-white/10">
                <span className="font-medium text-foreground">
                  Drop your file(s) here
                </span>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {isFree && !isTrial
                    ? `Only *.pdf, *.xls, *.xlsx, *.csv, *.tsv, *.ods, *.png, *.jpeg, *.jpg`
                    : `Only *.pdf, *.pptx, *.docx, *.xlsx, *.xls, *.csv, *.tsv, *.ods, *.ppt, *.odp, *.doc, *.odt, *.dwg, *.dxf, *.png, *.jpg, *.jpeg, *.mp4, *.mov, *.avi, *.webm, *.ogg`}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {children}
    </div>
  );
}
