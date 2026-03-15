module.exports = {
  channels: {
    announceNormal: '1336001867041472582',
    announceReload: '1457352183463805089',
    claimStaff: '1332722797772013639',
    claimHead: '1404104122927677490',
  },
  roles: {
    staff: '',
    headstaff: '',
  },
  timing: {
    preRegLeadMs: 60 * 60 * 1000,
    catchupMs: 90 * 60 * 1000,
  },
  limits: {
    staffMaxClaims: 10,
    headMaxClaims: 2,
  },
  behavior: {
    headImmediate: true,
  },
};
