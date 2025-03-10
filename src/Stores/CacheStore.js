/*
 *  Copyright (c) 2018-present, Evgeny Nadymov
 *
 * This source code is licensed under the GPL v.3.0 license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { EventEmitter } from 'events';
import { debounce } from '../Utils/Common';
import CacheManager from '../Workers/CacheManager';
import BasicGroupStore from './BasicGroupStore';
import ChatStore from './ChatStore';
import FileStore from './FileStore';
import OptionStore from './OptionStore';
import SupergroupStore from './SupergroupStore';
import UserStore from './UserStore';
import TdLibController from '../Controllers/TdLibController';

class CacheStore extends EventEmitter {
    constructor() {
        super();

        this.reset();

        this.addTdLibListener();
        this.setMaxListeners(Infinity);

        this.saveChatsInternal = debounce(this.saveChatsInternal, 2000);
    }

    reset = () => {
        this.chatIds = [];
        this.cache = null;
    };

    onUpdate = update => {
        switch (update['@type']) {
            case 'updateAuthorizationState': {
                const { authorization_state } = update;
                if (!authorization_state) break;

                switch (authorization_state['@type']) {
                    case 'authorizationStateClosed': {
                        this.reset();
                        break;
                    }
                    case 'authorizationStateLoggingOut':
                    case 'authorizationStateWaitCode':
                    case 'authorizationStateWaitPhoneNumber':
                    case 'authorizationStateWaitPassword':
                    case 'authorizationStateWaitRegistration': {
                        CacheManager.remove('cache');
                        CacheManager.remove('files');
                        break;
                    }
                }

                break;
            }
            default:
                break;
        }
    };

    onClientUpdate = update => {
        switch (update['@type']) {
            case 'clientUpdateDialogsReady': {
                this.clear();
            }
            default:
                break;
        }
    };

    addTdLibListener = () => {
        TdLibController.addListener('update', this.onUpdate);
        TdLibController.addListener('clientUpdate', this.onClientUpdate);
    };

    removeTdLibListener = () => {
        TdLibController.removeListener('update', this.onUpdate);
        TdLibController.removeListener('clientUpdate', this.onClientUpdate);
    };

    async getChats() {
        // console.log('[cm] getChats start');
        const promises = [];
        promises.push(CacheManager.load('cache').catch(error => null));
        promises.push(CacheManager.load('files').catch(error => null));
        const [cache, files] = await Promise.all(promises);
        this.cache = cache;
        if (this.cache) {
            this.cache.files = files || [];
        }
        // console.log('[cm] getChats result', this.cache);
        if (!this.cache) return null;

        this.parseCache(this.cache);
        const { chats } = this.cache;

        return chats || [];
    }

    parseCache(cache) {
        if (!cache) return;

        const { chats, users, basicGroups, supergroups, files, options } = cache;

        (files || []).forEach(({ id, url }) => {
            FileStore.setDataUrl(id, url);
        });

        (users || []).forEach(x => {
            UserStore.set(x);
        });

        (basicGroups || []).forEach(x => {
            BasicGroupStore.set(x);
        });

        (supergroups || []).forEach(x => {
            SupergroupStore.set(x);
        });

        (chats || []).forEach(x => {
            ChatStore.set(x);
            if (x.photo) {
                if (x.photo.small) FileStore.set(x.photo.small);
                if (x.photo.big) FileStore.set(x.photo.big);
            }
        });

        (options || []).forEach(([id, option]) => {
            OptionStore.set(id, option);
        });
    }

    getCache(chatIds) {
        const fileMap = new Map();
        const userMap = new Map();
        const basicGroupMap = new Map();
        const supergroupMap = new Map();
        const chats = chatIds.map(x => ChatStore.get(x));
        chats.forEach(x => {
            const { photo, type, last_message } = x;
            if (photo && photo.small) {
                const { id } = photo.small;
                if (id) {
                    const blob = FileStore.getBlob(id);
                    if (blob) {
                        fileMap.set(id, blob);
                    }
                }
            }

            switch (type['@type']) {
                case 'chatTypeBasicGroup': {
                    const basicGroup = BasicGroupStore.get(type.basic_group_id);
                    if (basicGroup) {
                        basicGroupMap.set(basicGroup.id, basicGroup);
                    }
                }
                case 'chatTypePrivate':
                case 'chatTypeSecret': {
                    const user = UserStore.get(type.user_id);
                    if (user) {
                        userMap.set(user.id, user);
                    }
                }
                case 'chatTypeSupergroup': {
                    const supergroup = SupergroupStore.get(type.supergroup_id);
                    if (supergroup) {
                        supergroupMap.set(supergroup.id, supergroup);
                    }
                }
            }

            if (last_message) {
                const { sender_user_id } = last_message;
                if (sender_user_id) {
                    const user = UserStore.get(sender_user_id);
                    if (user) {
                        userMap.set(user.id, user);
                    }
                }
            }
        });

        return {
            chats,
            users: [...userMap.values()],
            basicGroups: [...basicGroupMap.values()],
            supergroups: [...supergroupMap.values()],
            files: [...fileMap.entries()],
            options: [...OptionStore.items.entries()]
        };
    }

    saveChats(chatIds) {
        // console.log('[cm] saveChats', chatIds);
        this.chatIds = chatIds;
        this.saveChatsInternal();
    }

    async saveChatsInternal() {
        const cache = this.getCache(this.chatIds);
        const files = cache.files;
        cache.files = [];
        // console.log('[cm] save cache', cache);
        await CacheManager.save('cache', cache);

        const promises = [];
        files.forEach(x => {
            const [id, blob] = x;
            promises.push(
                new Promise((resolve, reject) => {
                    const fileReader = new FileReader();
                    fileReader.readAsDataURL(blob);
                    fileReader.onload = e => {
                        resolve({ id, url: e.target.result });
                    };
                    fileReader.onerror = e => {
                        resolve(null);
                    };
                })
            );
        });
        // console.log('[cm] save files start', files);
        const results = await Promise.all(promises);
        // console.log('[cm] save files', results);
        await CacheManager.save('files', results);
    }

    clear() {
        if (!this.cache) return;

        const { files } = this.cache;

        files.forEach(({ id, url }) => {
            FileStore.deleteDataUrl(id);
        });
    }
}

const store = new CacheStore();
window.cache = store;
export default store;
