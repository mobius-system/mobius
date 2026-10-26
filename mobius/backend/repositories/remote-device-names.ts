import { db } from '../../db';
import { createRemoteDeviceNamesStore, remoteDeviceNameKey } from '../services/remote-device-name-store';

const RemoteDeviceNames = createRemoteDeviceNamesStore(db);

export { RemoteDeviceNames, remoteDeviceNameKey };
