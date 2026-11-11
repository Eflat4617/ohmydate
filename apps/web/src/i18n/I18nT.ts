import { Fragment, defineComponent, h, type PropType, type VNodeArrayChildren } from 'vue';
import { lookup, type MessageKey } from './index';
import type { ParamValue } from './types';

/**
 * Renders a catalog message whose placeholders need markup, without v-html:
 *   <I18nT keypath="conflict.detail"><template #version><strong>3</strong></template></I18nT>
 * A named slot fills `{name}`; `params` fills plain values. The output is a
 * fragment, so it sits inline inside the caller's element.
 */
export default defineComponent({
  name: 'I18nT',
  props: {
    keypath: { type: String as PropType<MessageKey>, required: true },
    params: { type: Object as PropType<Record<string, ParamValue>>, default: () => ({}) },
  },
  setup(props, { slots }) {
    return () => {
      const message = lookup(props.keypath);
      const template = typeof message === 'string' ? message : props.keypath;
      const children: VNodeArrayChildren = [];
      let cursor = 0;
      for (const match of template.matchAll(/\{(\w+)\}/g)) {
        const name = match[1] ?? '';
        const index = match.index ?? 0;
        if (index > cursor) children.push(template.slice(cursor, index));
        const slot = slots[name];
        if (slot !== undefined) children.push(slot());
        else if (Object.prototype.hasOwnProperty.call(props.params, name)) children.push(String(props.params[name]));
        else children.push(match[0]);
        cursor = index + match[0].length;
      }
      if (cursor < template.length) children.push(template.slice(cursor));
      return h(Fragment, null, children);
    };
  },
});
