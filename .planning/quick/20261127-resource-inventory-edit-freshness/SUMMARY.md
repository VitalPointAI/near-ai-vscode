# Resource Inventory catalogue edit freshness

Fixed the local Resource Inventory editor so a same-length file change with the same ETag refuses Save and asks the user to refresh. The dialog holds the source that populated its visible catalogue. Save compares the original decoded text and encoding both before deriving the edited document and again before the guarded write. This preserves Theia's handling of existing file encodings. The write keeps its original mtime and ETag guards, and the update preserves unrecognized metadata. The regular local path and active trusted workspace are rechecked before writing.

The independently reviewed plan preceded implementation. With the old comparison, both same-ETag regression cases failed to refuse Save. The final focused inventory and work-area resource-link runs passed all 11 checks. The capped Workbench extension and test/tools type checks and `git diff --check` passed. The exact diff passed independent source review.

## Open conditions

No new gap ID is needed for the verified stale edit fix. Theia provides no atomic content comparison against an external writer after the final read. Different byte sequences that Theia decodes to identical text with the same encoding are indistinguishable to this check. Integration and combined CI follow the repository's PR queue.
