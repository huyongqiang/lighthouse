/**
 * @license Copyright 2018 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const path = require('path');
const isDeepEqual = require('lodash.isequal');
const log = require('lighthouse-logger');
const MessageFormat = require('intl-messageformat').default;
const MessageParser = require('intl-messageformat-parser');
const LOCALES = require('./locales');

const LH_ROOT = path.join(__dirname, '../../');
const MESSAGE_INSTANCE_ID_REGEX = /(.* \| .*) # (\d+)$/;

(() => {
  // Node usually doesn't come with the locales we want built-in, so load the polyfill if we can.

  try {
    // @ts-ignore
    const IntlPolyfill = require('intl');
    // In browser environments where we don't need the polyfill, this won't exist
    if (!IntlPolyfill.NumberFormat) return;

    // @ts-ignore
    Intl.NumberFormat = IntlPolyfill.NumberFormat;
    // @ts-ignore
    Intl.DateTimeFormat = IntlPolyfill.DateTimeFormat;
  } catch (_) {
    log.warn('i18n', 'Failed to install `intl` polyfill');
  }
})();


const UIStrings = {
  ms: '{timeInMs, number, milliseconds}\xa0ms',
  displayValueByteSavings: 'Potential savings of {wastedBytes, number, bytes}\xa0KB',
  displayValueMsSavings: 'Potential savings of {wastedMs, number, milliseconds}\xa0ms',
  columnURL: 'URL',
  columnSize: 'Size (KB)',
  columnCacheTTL: 'Cache TTL',
  columnWastedBytes: 'Potential Savings (KB)',
  columnWastedMs: 'Potential Savings (ms)',
  columnTimeSpent: 'Time Spent',
};

const formats = {
  number: {
    bytes: {
      maximumFractionDigits: 0,
    },
    milliseconds: {
      maximumFractionDigits: 0,
    },
  },
};

/**
 * @param {string} icuMessage
 * @param {Record<string, *>} [values]
 */
function _preprocessMessageValues(icuMessage, values) {
  if (!values) return;

  const clonedValues = JSON.parse(JSON.stringify(values));
  const parsed = MessageParser.parse(icuMessage);
  // Throw an error if a message's value isn't provided
  parsed.elements
    .filter(el => el.type === 'argumentElement')
    .forEach(el => {
      if (el.id && (el.id in values) === false) {
        throw new Error('ICU Message contains a value reference that wasn\'t provided');
      }
    });

  // Round all milliseconds to the nearest 10
  parsed.elements
    .filter(el => el.format && el.format.style === 'milliseconds')
    // @ts-ignore - el.id is always defined when el.format is defined
    .forEach(el => (clonedValues[el.id] = Math.round(clonedValues[el.id] / 10) * 10));

  // Replace all the bytes with KB
  parsed.elements
    .filter(el => el.format && el.format.style === 'bytes')
    // @ts-ignore - el.id is always defined when el.format is defined
    .forEach(el => (clonedValues[el.id] = clonedValues[el.id] / 1024));

  return clonedValues;
}

/**
 * @typedef IcuMessageInstance
 * @prop {string} icuMessageId
 * @prop {string} icuMessage
 * @prop {*} [values]
 */

/** @type {Map<string, IcuMessageInstance[]>} */
const _icuMessageInstanceMap = new Map();

/**
 *
 * @param {LH.Locale} locale
 * @param {string} icuMessageId
 * @param {string} icuMessage
 * @param {*} [values]
 * @return {{formattedString: string, icuMessage: string}}
 */
function _formatIcuMessage(locale, icuMessageId, icuMessage, values) {
  const localeMessages = LOCALES[locale] || {};
  const localeMessage = localeMessages[icuMessageId] && localeMessages[icuMessageId].message;
  // fallback to the original english message if we couldn't find a message in the specified locale
  // better to have an english message than no message at all, in some number cases it won't even matter
  const messageForMessageFormat = localeMessage || icuMessage;
  // when using accented english, force the use of a different locale for number formatting
  const localeForMessageFormat = locale === 'en-XA' ? 'de-DE' : locale;
  // pre-process values for the message format like KB and milliseconds
  const valuesForMessageFormat = _preprocessMessageValues(icuMessage, values);

  const formatter = new MessageFormat(messageForMessageFormat, localeForMessageFormat, formats);
  const formattedString = formatter.format(valuesForMessageFormat);

  return {formattedString, icuMessage: messageForMessageFormat};
}

/** @param {string[]} pathInLHR */
function _formatPathAsString(pathInLHR) {
  let pathAsString = '';
  for (const property of pathInLHR) {
    if (/^[a-z]+$/i.test(property)) {
      if (pathAsString.length) pathAsString += '.';
      pathAsString += property;
    } else {
      if (/]|"|'|\s/.test(property)) throw new Error(`Cannot handle "${property}" in i18n`);
      pathAsString += `[${property}]`;
    }
  }

  return pathAsString;
}

/**
 * @return {LH.Locale}
 */
function getDefaultLocale() {
  const defaultLocale = MessageFormat.defaultLocale;
  if (defaultLocale in LOCALES) return /** @type {LH.Locale} */ (defaultLocale);
  return 'en-US';
}

/**
 * @param {LH.Locale} locale
 * @return {LH.I18NRendererStrings}
 */
function getRendererFormattedStrings(locale) {
  const icuMessageIds = Object.keys(LOCALES[locale]).filter(f => f.includes('core/report/html/'));
  const strings = {};
  for (const icuMessageId of icuMessageIds) {
    const [filename, varName] = icuMessageId.split(' | ');
    if (!filename.endsWith('util.js')) throw new Error(`Unexpected message: ${icuMessageId}`);
    strings[varName] = LOCALES[locale][icuMessageId].message;
  }

  return strings;
}

/**
 * @param {string} filename
 * @param {Record<string, string>} fileStrings
 */
function createMessageInstanceIdFn(filename, fileStrings) {
  const mergedStrings = {...UIStrings, ...fileStrings};

  /** @param {string} icuMessage @param {*} [values] */
  const getMessageInstanceIdFn = (icuMessage, values) => {
    const keyname = Object.keys(mergedStrings).find(key => mergedStrings[key] === icuMessage);
    if (!keyname) throw new Error(`Could not locate: ${icuMessage}`);

    const filenameToLookup = keyname in fileStrings ? filename : __filename;
    const unixStyleFilename = path.relative(LH_ROOT, filenameToLookup).replace(/\\/g, '/');
    const icuMessageId = `${unixStyleFilename} | ${keyname}`;
    const icuMessageInstances = _icuMessageInstanceMap.get(icuMessageId) || [];

    let indexOfInstance = icuMessageInstances.findIndex(inst => isDeepEqual(inst.values, values));
    if (indexOfInstance === -1) {
      icuMessageInstances.push({icuMessageId, icuMessage, values});
      indexOfInstance = icuMessageInstances.length - 1;
    }

    _icuMessageInstanceMap.set(icuMessageId, icuMessageInstances);

    return `${icuMessageId} # ${indexOfInstance}`;
  };

  return getMessageInstanceIdFn;
}

/**
 * @param {string} icuMessageIdOrRawString
 * @param {LH.Locale} [locale]
 * @return {string}
 */
function getFormatted(icuMessageIdOrRawString, locale) {
  if (MESSAGE_INSTANCE_ID_REGEX.test(icuMessageIdOrRawString)) {
    return _resolveIcuMessageInstanceId(icuMessageIdOrRawString, locale).formattedString;
  }

  return icuMessageIdOrRawString;
}

/**
 * @param {string} icuMessageInstanceId
 * @param {LH.Locale} [locale]
 * @return {{icuMessageInstance: IcuMessageInstance, formattedString: string}}
 */
function _resolveIcuMessageInstanceId(icuMessageInstanceId, locale = 'en-US') {
  const matches = icuMessageInstanceId.match(MESSAGE_INSTANCE_ID_REGEX);
  if (!matches) throw new Error(`${icuMessageInstanceId} is not a valid message instance ID`);

  const [_, icuMessageId, icuMessageInstanceIndex] = matches;
  const icuMessageInstances = _icuMessageInstanceMap.get(icuMessageId) || [];
  const icuMessageInstance = icuMessageInstances[Number(icuMessageInstanceIndex)];

  const {formattedString} = _formatIcuMessage(locale, icuMessageId,
    icuMessageInstance.icuMessage, icuMessageInstance.values);

  return {icuMessageInstance, formattedString};
}

/**
 * @param {LH.Result} lhr
 * @param {LH.Locale} locale
 */
function replaceIcuMessageInstanceIds(lhr, locale) {
  /**
   * @param {*} objectInLHR
   * @param {LH.I18NMessages} icuMessagePaths
   * @param {string[]} pathInLHR
   */
  function replaceInObject(objectInLHR, icuMessagePaths, pathInLHR = []) {
    if (typeof objectInLHR !== 'object' || !objectInLHR) return;

    for (const [property, value] of Object.entries(objectInLHR)) {
      const currentPathInLHR = pathInLHR.concat([property]);

      // Check to see if the value in the LHR looks like a string reference. If it is, replace it.
      if (typeof value === 'string' && MESSAGE_INSTANCE_ID_REGEX.test(value)) {
        const {icuMessageInstance, formattedString} = _resolveIcuMessageInstanceId(value, locale);
        const messageInstancesInLHR = icuMessagePaths[icuMessageInstance.icuMessageId] || [];
        const currentPathAsString = _formatPathAsString(currentPathInLHR);

        messageInstancesInLHR.push(
          icuMessageInstance.values ?
            {values: icuMessageInstance.values, path: currentPathAsString} :
            currentPathAsString
        );

        objectInLHR[property] = formattedString;
        icuMessagePaths[icuMessageInstance.icuMessageId] = messageInstancesInLHR;
      } else {
        replaceInObject(value, icuMessagePaths, currentPathInLHR);
      }
    }
  }

  const icuMessagePaths = {};
  replaceInObject(lhr, icuMessagePaths);
  return icuMessagePaths;
}

module.exports = {
  _formatPathAsString,
  UIStrings,
  getDefaultLocale,
  getRendererFormattedStrings,
  createMessageInstanceIdFn,
  getFormatted,
  replaceIcuMessageInstanceIds,
};
