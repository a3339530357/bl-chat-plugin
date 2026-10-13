// 合成数据：保留语义期待供后续提取阶段使用，本阶段只验证原料不丢失、不串群。
export const memorySourceCases = [
  { id: 'identity', group: 'group-a', qq: '101', text: '我是前端开发，平时不喝咖啡。', expected: 'explicit_self_report' },
  { id: 'joke', group: 'group-a', qq: '102', text: '我其实是外星人，哈哈开玩笑的。', expected: 'not_stable_fact' },
  { id: 'quote', group: 'group-a', qq: '102', text: '他说“我是医生”，不是我。', reply: 'identity', expected: 'quoted_subject' },
  { id: 'other-group', group: 'group-b', qq: '101', text: '在这个群叫我阿乙。', expected: 'group_isolated' },
  { id: 'solar', group: 'group-a', qq: '101', text: '我的生日是公历十月三日，不记出生年份。', expected: 'solar_unknown_year' },
  { id: 'lunar', group: 'group-a', qq: '102', text: '我的生日按农历八月十五过。', expected: 'lunar_calendar' },
  { id: 'unknown-calendar', group: 'group-a', qq: '103', text: '我生日是八月十五。', expected: 'calendar_unknown' },
  { id: 'plan', group: 'group-a', qq: '101', text: '明天晚上组织群内联机，大家来吗？', expected: 'planned' },
  { id: 'occurred', group: 'group-a', qq: '102', day: 4, text: '昨晚大家确实联机了，阿甲也来了。', expected: 'occurred_previous_day' },
  { id: 'cancel', group: 'group-a', qq: '103', day: 4, text: '今晚的第二场取消了。', expected: 'cancelled_not_first_event' },
  { id: 'correction', group: 'group-a', qq: '101', day: 4, text: '纠正一下，之前说前端是开玩笑的，我一直是后端开发。', expected: 'correction_not_job_change' },
  { id: 'same-name', group: 'group-a', qq: '104', text: '我和101都叫阿甲，但不是同一个人。', expected: 'distinct_identity' }
]

export function sourceCaseEvent(item) {
  return { self_id: 'bot', message_type: 'group', group_id: item.group, message_id: item.id,
    time: Date.parse(`2026-10-${String(item.day || 3).padStart(2, '0')}T00:15:00+08:00`) / 1000,
    sender: { user_id: item.qq, nickname: '阿甲' },
    message: [...(item.reply ? [{ type: 'reply', id: item.reply }] : []), { type: 'text', text: item.text }] }
}
