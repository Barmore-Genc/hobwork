// The body of the route a share target from hobwork.json's "share" runs when
// someone shares into it from another app ("Share to Hobwork" in the share
// sheet). ctx.caller is the person and device that shared.
export type ShareRequest = {
  // The target's id.
  target: string
  // A web link that was shared, for targets that accept urls.
  url?: string
  // Text that was shared, for targets that accept text.
  text?: string
  // Files that were shared, already stored in the target's upload folder
  // (read them with ctx.files.get(path)). Empty when none were shared.
  files: SharedFile[]
}

export type SharedFile = {
  // Where the file is in ctx.files, under the upload's prefix.
  path: string
  // The file's name in the app it came from.
  name: string
  size: number
  contentType: string | null
}

// What a share target's route may return. say is shown in the share sheet
// ("Added Headphone stand to the queue").
export type ShareResult = {
  say?: string
}
