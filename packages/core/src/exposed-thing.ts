/********************************************************************************
 * Copyright (c) 2022 Contributors to the Eclipse Foundation
 *
 * See the NOTICE file(s) distributed with this work for additional
 * information regarding copyright ownership.
 *
 * This program and the accompanying materials are made available under the
 * terms of the Eclipse Public License v. 2.0 which is available at
 * http://www.eclipse.org/legal/epl-2.0, or the W3C Software Notice and
 * Document License (2015-05-13) which is available at
 * https://www.w3.org/Consortium/Legal/2015/copyright-software-and-document.
 *
 * SPDX-License-Identifier: EPL-2.0 OR W3C-20150513
 ********************************************************************************/

import * as WoT from "wot-typescript-definitions";
import * as TDT from "wot-thing-description-types";

import { Subject } from "rxjs/Subject";

import * as TD from "@node-wot/td-tools";

import Servient from "./servient";
import Helpers from "./helpers";
import { InteractionOutput } from "./interaction-output";
import { Readable } from "stream";
import ProtocolHelpers from "./protocol-helpers";
import { ReadableStream as PolyfillStream } from "web-streams-polyfill/ponyfill/es2018";
import { Content, PropertyContentMap } from "./core";
import ContentManager from "./content-serdes";
import {
    ActionHandlerMap,
    ContentListener,
    EventHandlerMap,
    EventHandlers,
    PropertyHandlerMap,
    PropertyHandlers,
} from "./protocol-interfaces";
import ProtocolListenerRegistry from "./protocol-listener-registry";
import { createLoggers } from "./logger";

const { debug } = createLoggers("core", "exposed-thing");

export default class ExposedThing extends TD.Thing implements WoT.ExposedThing {
    security: string | [string, ...string[]];
    securityDefinitions: {
        [key: string]: TDT.SecurityScheme;
    };

    id: string;
    title: string;
    base?: string;
    forms?: Array<TD.Form>;

    /** A map of interactable Thing Properties with read()/write()/subscribe() functions */
    properties: {
        [key: string]: TDT.PropertyElement;
    };

    /** A map of interactable Thing Actions with invoke() function */
    actions: {
        [key: string]: TDT.ActionElement;
    };

    /** A map of interactable Thing Events with emit() function */
    events: {
        [key: string]: TDT.EventElement;
    };

    /** A map of property (read & write) handler callback functions */
    __propertyHandlers: PropertyHandlerMap = new Map<string, PropertyHandlers>();

    /** A map of action handler callback functions */
    __actionHandlers: ActionHandlerMap = new Map<string, WoT.ActionHandler>();

    /** A map of event handler callback functions */
    __eventHandlers: EventHandlerMap = new Map<string, EventHandlers>();

    /** A map of property listener callback functions */
    __propertyListeners: ProtocolListenerRegistry = new ProtocolListenerRegistry();

    /** A map of event listener callback functions */
    __eventListeners: ProtocolListenerRegistry = new ProtocolListenerRegistry();

    private getServient: () => Servient;
    private getSubjectTD: () => Subject<WoT.ThingDescription>;

    constructor(servient: Servient, thingModel: WoT.ExposedThingInit = {}) {
        super();

        this.getServient = () => {
            return servient;
        };
        this.getSubjectTD = new (class {
            subjectTDChange: Subject<WoT.ThingDescription> = new Subject<WoT.ThingDescription>();
            getSubject = () => {
                return this.subjectTDChange;
            };
        })().getSubject;
        // The init object might still have undefined values, so initialize them here.
        // TODO: who checks that those are valid?
        this.id = thingModel.id ?? "";
        this.title = thingModel.title ?? "";
        this.security = "";
        this.securityDefinitions = {};
        this.properties = {};
        this.actions = {};
        this.events = {};
        // Deep clone the Thing Model
        // without functions or methods
        const clonedModel = JSON.parse(JSON.stringify(thingModel));
        Object.assign(this, clonedModel);

        // unset "@type":"tm:ThingModel" ?
        // see https://github.com/eclipse/thingweb.node-wot/issues/426
        /* if (this["@type"]) {
            if (typeof this["@type"] === 'string' && this["@type"] === "tm:ThingModel") {
                delete this["@type"];
            } else if (Array.isArray(this["@type"])) {
                let arr: Array<any> = this["@type"];
                for (var i = 0; i < arr.length; i++) {
                    if (arr[i] === "tm:ThingModel") {
                        arr.splice(i, 1);
                        i--;
                    }
                }
            }
        } */
        // set @language to "en" if no @language available
        TD.setContextLanguage(this, TD.DEFAULT_CONTEXT_LANGUAGE, false);
    }

    public getThingDescription(): WoT.ThingDescription {
        return JSON.parse(TD.serializeTD(this), (key, value) => {
            // Check if key matches internals like "__propertyHandlers", "__actionHandlers", ...
            // if matched return value "undefined"
            if (
                key === "__propertyHandlers" ||
                key === "__actionHandlers" ||
                key === "__eventHandlers" ||
                key === "__propertyListeners" ||
                key === "__eventListeners"
            ) {
                return undefined;
            }
            // else return the value itself
            return value;
        });
    }

    public emitEvent(name: string, data: WoT.InteractionInput): void {
        if (this.events[name]) {
            const eventAffordance = this.events[name];
            this.__eventListeners.notify(eventAffordance, data, eventAffordance.data);
        } else {
            // NotFoundError
            throw new Error("NotFoundError for event '" + name + "'");
        }
    }

    public async emitPropertyChange(name: string): Promise<void> {
        if (this.properties[name]) {
            const property = this.properties[name];
            const readHandler = this.__propertyHandlers.get(name)?.readHandler;

            if (!readHandler) {
                throw new Error(
                    "Can't read property readHandler is not defined. Did you forget to register a readHandler?"
                );
            }

            const data = await readHandler();
            this.__propertyListeners.notify(property, data, property);
        } else {
            // NotFoundError
            throw new Error("NotFoundError for property '" + name + "'");
        }
    }

    /** @inheritDoc */
    expose(): Promise<void> {
        debug(`ExposedThing '${this.title}' exposing all Interactions and TD`);

        return new Promise<void>((resolve, reject) => {
            // let servient forward exposure to the servers
            this.getServient()
                .expose(this)
                .then(() => {
                    // inform TD observers
                    this.getSubjectTD().next(this.getThingDescription());
                    resolve();
                })
                .catch((err) => reject(err));
        });
    }

    /** @inheritDoc */
    async destroy(): Promise<void> {
        debug(`ExposedThing '${this.title}' destroying the thing and its interactions`);
        await this.getServient().destroyThing(this.id);

        this.__eventListeners.unregisterAll();
        this.__propertyListeners.unregisterAll();
        this.__eventHandlers.clear();
        this.__propertyHandlers.clear();
        this.__eventHandlers.clear();
        // inform TD observers that thing is gone
        this.getSubjectTD().next();
    }

    /** @inheritDoc */
    setPropertyReadHandler(propertyName: string, handler: WoT.PropertyReadHandler): WoT.ExposedThing {
        debug(`ExposedThing '${this.title}' setting read handler for '${propertyName}'`);

        if (this.properties[propertyName]) {
            // setting read handler for writeOnly not allowed
            if (this.properties[propertyName].writeOnly) {
                throw new Error(
                    `ExposedThing '${this.title}' cannot set read handler for property '${propertyName}' due to writeOnly flag`
                );
            } else {
                let propertyHandler = this.__propertyHandlers.get(propertyName);
                if (propertyHandler) {
                    propertyHandler.readHandler = handler;
                } else {
                    propertyHandler = { readHandler: handler };
                }

                this.__propertyHandlers.set(propertyName, propertyHandler);
            }
        } else {
            throw new Error(`ExposedThing '${this.title}' has no Property '${propertyName}'`);
        }
        return this;
    }

    /** @inheritDoc */
    setPropertyWriteHandler(propertyName: string, handler: WoT.PropertyWriteHandler): WoT.ExposedThing {
        debug(`ExposedThing '${this.title}' setting write handler for '${propertyName}'`);
        if (this.properties[propertyName]) {
            // setting write handler for readOnly not allowed
            if (this.properties[propertyName].readOnly) {
                throw new Error(
                    `ExposedThing '${this.title}' cannot set write handler for property '${propertyName}' due to readOnly flag`
                );
            } else {
                let propertyHandler = this.__propertyHandlers.get(propertyName);
                if (propertyHandler) {
                    propertyHandler.writeHandler = handler;
                } else {
                    propertyHandler = { writeHandler: handler };
                }

                this.__propertyHandlers.set(propertyName, propertyHandler);
            }
        } else {
            throw new Error(`ExposedThing '${this.title}' has no Property '${propertyName}'`);
        }
        return this;
    }

    /** @inheritDoc */
    setPropertyObserveHandler(name: string, handler: WoT.PropertyReadHandler): WoT.ExposedThing {
        debug(`ExposedThing '${this.title}' setting property observe handler for '${name}'`);

        if (this.properties[name]) {
            if (!this.properties[name].observable) {
                throw new Error(
                    `ExposedThing '${this.title}' cannot set observe handler for property '${name}' since the observable flag is set to false`
                );
            } else {
                let propertyHandler = this.__propertyHandlers.get(name);
                if (propertyHandler) {
                    propertyHandler.observeHandler = handler;
                } else {
                    propertyHandler = { observeHandler: handler };
                }
                this.__propertyHandlers.set(name, propertyHandler);
            }
        } else {
            throw new Error(`ExposedThing '${this.title}' has no Property '${name}'`);
        }
        return this;
    }

    /** @inheritDoc */
    setPropertyUnobserveHandler(name: string, handler: WoT.PropertyReadHandler): WoT.ExposedThing {
        debug(`ExposedThing '${this.title}' setting property unobserve handler for '${name}'`);

        if (this.properties[name]) {
            if (!this.properties[name].observable) {
                throw new Error(
                    `ExposedThing '${this.title}' cannot set unobserve handler for property '${name}' due to missing observable flag`
                );
            } else {
                let propertyHandler = this.__propertyHandlers.get(name);
                if (propertyHandler) {
                    propertyHandler.unobserveHandler = handler;
                } else {
                    propertyHandler = { unobserveHandler: handler };
                }
                this.__propertyHandlers.set(name, propertyHandler);
            }
        } else {
            throw new Error(`ExposedThing '${this.title}' has no Property '${name}'`);
        }
        return this;
    }

    /** @inheritDoc */
    setActionHandler(actionName: string, handler: WoT.ActionHandler): WoT.ExposedThing {
        debug(`ExposedThing '${this.title}' setting action handler for '${actionName}'`);

        if (this.actions[actionName]) {
            this.__actionHandlers.set(actionName, handler);
        } else {
            throw new Error(`ExposedThing '${this.title}' has no Action '${actionName}'`);
        }
        return this;
    }

    /** @inheritDoc */
    setEventSubscribeHandler(name: string, handler: WoT.EventSubscriptionHandler): WoT.ExposedThing {
        debug(`ExposedThing '${this.title}' setting event subscribe handler for '${name}'`);

        if (this.events[name]) {
            let eventHandler = this.__eventHandlers.get(name);
            if (eventHandler) {
                eventHandler.subscribe = handler;
            } else {
                eventHandler = { subscribe: handler };
            }

            this.__eventHandlers.set(name, eventHandler);
        } else {
            throw new Error(`ExposedThing '${this.title}' has no Event '${name}'`);
        }
        return this;
    }

    /** @inheritDoc */
    setEventUnsubscribeHandler(name: string, handler: WoT.EventSubscriptionHandler): WoT.ExposedThing {
        debug(`ExposedThing '${this.title}' setting event unsubscribe handler for '${name}'`);

        if (this.events[name]) {
            let eventHandler = this.__eventHandlers.get(name);
            if (eventHandler) {
                eventHandler.unsubscribe = handler;
            } else {
                eventHandler = { unsubscribe: handler };
            }

            this.__eventHandlers.set(name, eventHandler);
        } else {
            throw new Error(`ExposedThing '${this.title}' has no Event '${name}'`);
        }
        return this;
    }

    /** @inheritDoc */
    setEventHandler(name: string, handler: WoT.EventListenerHandler): WoT.ExposedThing {
        debug(`ExposedThing '${this.title}' setting event handler for '${name}'`);

        if (this.events[name]) {
            let eventHandler = this.__eventHandlers.get(name);
            if (eventHandler) {
                eventHandler.handler = handler;
            } else {
                eventHandler = { handler: handler };
            }

            this.__eventHandlers.set(name, eventHandler);
        } else {
            throw new Error(`ExposedThing '${this.title}' has no Event '${name}'`);
        }
        return this;
    }

    /**
     * Handle the request of an action invocation form the protocol binding level
     * @experimental
     */
    public async handleInvokeAction(
        name: string,
        inputContent: Content,
        options: WoT.InteractionOptions & { formIndex: number }
    ): Promise<Content | void> {
        // TODO: handling URI variables?
        if (this.actions[name]) {
            debug(`ExposedThing '${this.title}' has Action state of '${name}'`);

            const handler = this.__actionHandlers.get(name);
            if (handler != null) {
                debug(`ExposedThing '${this.title}' calls registered handler for Action '${name}'`);
                Helpers.validateInteractionOptions(this, this.actions[name], options);
                const form = this.actions[name].forms
                    ? this.actions[name].forms[options.formIndex]
                    : { contentType: "application/json" };
                const result: WoT.InteractionInput | void = await handler(
                    new InteractionOutput(inputContent, form, this.actions[name].input),
                    options
                );
                if (result) {
                    // TODO: handle form.response.contentType
                    return ContentManager.valueToContent(result, this.actions[name].output, form.contentType);
                }
            } else {
                throw new Error(`ExposedThing '${this.title}' has no handler for Action '${name}'`);
            }
        } else {
            throw new Error(`ExposedThing '${this.title}', no action found for '${name}'`);
        }
    }

    /**
     * Handle the request of a property read operation from the protocol binding level
     * @experimental
     */
    public async handleReadProperty(
        propertyName: string,
        options: WoT.InteractionOptions & { formIndex: number }
    ): Promise<Content> {
        if (this.properties[propertyName]) {
            debug(`ExposedThing '${this.title}' has Action state of '${propertyName}'`);

            const readHandler = this.__propertyHandlers.get(propertyName)?.readHandler;

            if (readHandler != null) {
                debug(`ExposedThing '${this.title}' calls registered readHandler for Property '${propertyName}'`);
                Helpers.validateInteractionOptions(this, this.properties[propertyName], options);
                const result: WoT.InteractionInput | void = await readHandler(options);
                const form = this.properties[propertyName].forms
                    ? this.properties[propertyName].forms[options.formIndex]
                    : { contentType: "application/json" };
                return ContentManager.valueToContent(
                    result,
                    this.properties[propertyName],
                    form?.contentType ?? "application/json"
                );
            } else {
                throw new Error(`ExposedThing '${this.title}' has no readHandler for Property '${propertyName}'`);
            }
        } else {
            throw new Error(`ExposedThing '${this.title}', no property found for '${propertyName}'`);
        }
    }

    /**
     * Handle the request of a read operation for multiple properties from the protocol binding level
     * @experimental
     */
    public async _handleReadProperties(
        propertyNames: string[],
        options: WoT.InteractionOptions & { formIndex: number }
    ): Promise<PropertyContentMap> {
        // collect all single promises into array
        const promises: Promise<Content>[] = [];
        for (const propertyName of propertyNames) {
            // Note: currently only DataSchema properties are supported
            const form = this.properties[propertyName].forms.find(
                (form) => form.contentType === "application/json" || !form.contentType
            );
            if (!form) {
                continue;
            }

            promises.push(this.handleReadProperty(propertyName, options));
        }
        try {
            // wait for all promises to succeed and create response
            const output = new Map<string, Content>();
            const results = await Promise.all(promises);

            for (let i = 0; i < results.length; i++) {
                output.set(propertyNames[i], results[i]);
            }
            return output;
        } catch (error) {
            throw new Error(
                `ConsumedThing '${this.title}', failed to read properties: ${propertyNames}.\n Error: ${error}`
            );
        }
    }

    /**
     * @experimental
     */
    public async handleReadAllProperties(
        options: WoT.InteractionOptions & { formIndex: number }
    ): Promise<PropertyContentMap> {
        const propertyNames: string[] = [];
        for (const propertyName in this.properties) {
            propertyNames.push(propertyName);
        }
        return await this._handleReadProperties(propertyNames, options);
    }

    /**
     * @experimental
     */
    public async handleReadMultipleProperties(
        propertyNames: string[],
        options: WoT.InteractionOptions & { formIndex: number }
    ): Promise<PropertyContentMap> {
        return await this._handleReadProperties(propertyNames, options);
    }

    /**
     * Handle the request of an property write operation to the protocol binding level
     * @experimental
     */
    public async handleWriteProperty(
        propertyName: string,
        inputContent: Content,
        options: WoT.InteractionOptions & { formIndex: number }
    ): Promise<void> {
        // TODO: to be removed next api does not allow an ExposedThing to be also a ConsumeThing
        if (this.properties[propertyName]) {
            if (this.properties[propertyName].readOnly && this.properties[propertyName].readOnly === true) {
                throw new Error(`ExposedThing '${this.title}', property '${propertyName}' is readOnly`);
            }
            Helpers.validateInteractionOptions(this, this.properties[propertyName], options);
            const writeHandler = this.__propertyHandlers.get(propertyName)?.writeHandler;
            const form = this.properties[propertyName].forms
                ? this.properties[propertyName].forms[options.formIndex]
                : {};
            // call write handler (if any)
            if (writeHandler != null) {
                await writeHandler(new InteractionOutput(inputContent, form, this.properties[propertyName]), options);
            } else {
                throw new Error(`ExposedThing '${this.title}' has no writeHandler for Property '${propertyName}'`);
            }
        } else {
            throw new Error(`ExposedThing '${this.title}', no property found for '${propertyName}'`);
        }
    }

    /**
     *
     * @experimental
     */
    public async handleWriteMultipleProperties(
        valueMap: PropertyContentMap,
        options: WoT.InteractionOptions & { formIndex: number }
    ): Promise<void> {
        // collect all single promises into array
        const promises: Promise<void>[] = [];
        for (const propertyName in valueMap) {
            // Note: currently only DataSchema properties are supported
            const form = this.properties[propertyName].forms.find(
                (form) => form.contentType === "application/json" || !form.contentType
            );
            if (!form) {
                continue;
            }
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- we know that the property exists
            promises.push(this.handleWriteProperty(propertyName, valueMap.get(propertyName)!, options));
        }
        try {
            await Promise.all(promises);
        } catch (error) {
            throw new Error(
                `ExposedThing '${this.title}', failed to write multiple properties. ${(<Error>error).message}`
            );
        }
    }

    /**
     *
     * @experimental
     */
    public async handleSubscribeEvent(
        name: string,
        listener: ContentListener,
        options: WoT.InteractionOptions & { formIndex: number }
    ): Promise<void> {
        if (this.events[name]) {
            Helpers.validateInteractionOptions(this, this.events[name], options);

            const formIndex = ProtocolHelpers.getFormIndexForOperation(
                this.events[name],
                "event",
                "subscribeevent",
                options.formIndex
            );

            if (formIndex !== -1) {
                this.__eventListeners.register(this.events[name], formIndex, listener);
                debug(`ExposedThing '${this.title}' subscribes to event '${name}'`);
            } else {
                throw new Error(
                    `ExposedThing '${this.title}', no property listener from found for '${name}' with form index '${options.formIndex}'`
                );
            }

            const subscribe = this.__eventHandlers.get(name)?.subscribe;
            if (subscribe) {
                await subscribe(options);
            }
            debug(`ExposedThing '${this.title}' subscribes to event '${name}'`);
        } else {
            throw new Error(`ExposedThing '${this.title}', no event found for '${name}'`);
        }
    }

    /**
     *
     * @experimental
     */
    public handleUnsubscribeEvent(
        name: string,
        listener: ContentListener,
        options: WoT.InteractionOptions & { formIndex: number }
    ): void {
        if (this.events[name]) {
            Helpers.validateInteractionOptions(this, this.events[name], options);

            const formIndex = ProtocolHelpers.getFormIndexForOperation(
                this.events[name],
                "event",
                "unsubscribeevent",
                options.formIndex
            );
            if (formIndex !== -1) {
                this.__eventListeners.unregister(this.events[name], formIndex, listener);
            } else {
                throw new Error(
                    `ExposedThing '${this.title}', no event listener from found for '${name}' with form index '${options.formIndex}'`
                );
            }
            const unsubscribe = this.__eventHandlers.get(name)?.unsubscribe;
            if (unsubscribe) {
                unsubscribe(options);
            }
            debug(`ExposedThing '${this.title}' unsubscribes from event '${name}'`);
        } else {
            throw new Error(`ExposedThing '${this.title}', no event found for '${name}'`);
        }
    }

    /**
     *
     * @experimental
     */
    public async handleObserveProperty(
        name: string,
        listener: ContentListener,
        options: WoT.InteractionOptions & { formIndex: number }
    ): Promise<void> {
        if (this.properties[name]) {
            Helpers.validateInteractionOptions(this, this.properties[name], options);
            const formIndex = ProtocolHelpers.getFormIndexForOperation(
                this.properties[name],
                "property",
                "observeproperty",
                options.formIndex
            );

            if (formIndex !== -1) {
                this.__propertyListeners.register(this.properties[name], formIndex, listener);
                debug(`ExposedThing '${this.title}' subscribes to property '${name}'`);
            } else {
                throw new Error(
                    `ExposedThing '${this.title}', no property listener from found for '${name}' with form index '${options.formIndex}'`
                );
            }

            const observeHandler = this.__propertyHandlers.get(name)?.observeHandler;
            if (observeHandler) {
                await observeHandler(options);
            }
        } else {
            throw new Error(`ExposedThing '${this.title}', no property found for '${name}'`);
        }
    }

    public handleUnobserveProperty(
        name: string,
        listener: ContentListener,
        options: WoT.InteractionOptions & { formIndex: number }
    ): void {
        if (this.properties[name]) {
            Helpers.validateInteractionOptions(this, this.properties[name], options);
            const formIndex = ProtocolHelpers.getFormIndexForOperation(
                this.properties[name],
                "property",
                "unobserveproperty",
                options.formIndex
            );

            if (formIndex !== -1) {
                this.__propertyListeners.unregister(this.properties[name], formIndex, listener);
            } else {
                throw new Error(
                    `ExposedThing '${this.title}', no property listener from found for '${name}' with form index '${options.formIndex}'`
                );
            }

            const unobserveHandler = this.__propertyHandlers.get(name)?.unobserveHandler;
            if (unobserveHandler) {
                unobserveHandler(options);
            }
        } else {
            throw new Error(`ExposedThing '${this.title}', no property found for '${name}'`);
        }
    }

    private static interactionInputToReadable(input: WoT.InteractionInput): Readable {
        let body;
        if (typeof ReadableStream !== "undefined" && input instanceof ReadableStream) {
            body = ProtocolHelpers.toNodeStream(input);
        } else if (input instanceof PolyfillStream) {
            body = ProtocolHelpers.toNodeStream(input);
        } else if (Array.isArray(input) || typeof input === "object") {
            body = Readable.from(Buffer.from(JSON.stringify(input), "utf-8"));
        } else {
            body = Readable.from(Buffer.from(input.toString(), "utf-8"));
        }
        return body;
    }
}
