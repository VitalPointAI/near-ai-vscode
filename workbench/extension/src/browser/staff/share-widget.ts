/**
 * Share with people on a page of its own (33-27), for an invitation opened from a file. Loaded on first use by share-part.ts, with Theia's
 * BaseWidget passed in, so the staff frontend module stays light (its module test loads it outside a browser).
 */
import type { BaseWidget } from '@theia/core/lib/browser/widgets/widget.js';
import { STAFF_SHARE_TEXT } from '../../common/staff-share.js';
import { ShareWithPeopleSection } from './share-section.js';

export { ShareWithPeopleSection };

export type ShareWidget = BaseWidget & { readonly section: ShareWithPeopleSection };

/** The page for the section, made from Theia's BaseWidget. */
export function shareWidgetOf(Base: typeof BaseWidget, section: ShareWithPeopleSection): ShareWidget {
  const widget = new Base() as ShareWidget;
  Object.defineProperty(widget, 'section', { value: section });
  widget.id = 'sterling-share-with-people';
  widget.title.label = STAFF_SHARE_TEXT.title;
  widget.title.caption = STAFF_SHARE_TEXT.title;
  widget.title.iconClass = 'codicon codicon-organization';
  widget.title.closable = true;
  widget.addClass('sterling-area');
  const page = document.createElement('main');
  page.className = 'sterling-area-page';
  page.append(section.node);
  widget.node.append(page);
  return widget;
}
