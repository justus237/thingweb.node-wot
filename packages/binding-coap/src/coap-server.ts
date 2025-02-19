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

/**
 * CoAP Server based on coap by mcollina
 */

import * as TD from "@node-wot/td-tools";
import Servient, {
    ProtocolServer,
    ContentSerdes,
    ExposedThing,
    Helpers,
    ProtocolHelpers,
    Content,
    createLoggers,
} from "@node-wot/core";
import { Socket } from "dgram";
import { Server, createServer, registerFormat, IncomingMessage, OutgoingMessage } from "coap";
import slugify from "slugify";
import { Readable } from "stream";

const { debug, warn, info, error } = createLoggers("binding-coap", "coap-server");

type CoreLinkFormatParameters = Map<string, string[] | number[]>;

const thingDescriptionParameters: CoreLinkFormatParameters = new Map(
    Object.entries({
        rt: ["wot.thing"],
        ct: [50, 432],
    })
);

interface CoreLinkFormatResource {
    urlPath: string;
    parameters?: CoreLinkFormatParameters;
}

export default class CoapServer implements ProtocolServer {
    public readonly scheme: string = "coap";

    private readonly PROPERTY_DIR = "properties";
    private readonly ACTION_DIR = "actions";
    private readonly EVENT_DIR = "events";

    private readonly port: number = 5683;
    private readonly address?: string = undefined;
    private readonly server: Server = createServer(
        { reuseAddr: false },
        (req: IncomingMessage, res: OutgoingMessage) => {
            this.handleRequest(req, res);
        }
    );

    private readonly things: Map<string, ExposedThing> = new Map<string, ExposedThing>();

    private readonly coreResources = new Map<string, CoreLinkFormatResource>();

    constructor(port?: number, address?: string) {
        if (port !== undefined) {
            this.port = port;
        }
        if (address !== undefined) {
            this.address = address;
        }

        // WoT-specific content formats
        registerFormat(ContentSerdes.JSON_LD, 2100);
    }

    public start(servient: Servient): Promise<void> {
        info(`CoapServer starting on ${this.address !== undefined ? this.address + " " : ""}port ${this.port}`);
        return new Promise<void>((resolve, reject) => {
            // start promise handles all errors until successful start
            this.server.once("error", (err: Error) => {
                reject(err);
            });
            this.server.listen(this.port, this.address, () => {
                // once started, console "handles" errors
                this.server.on("error", (err: Error) => {
                    error(`CoapServer for port ${this.port} failed: ${err.message}`);
                });
                resolve();
            });
        });
    }

    public stop(): Promise<void> {
        info(`CoapServer stopping on port ${this.getPort()}`);
        return new Promise<void>((resolve, reject) => {
            // stop promise handles all errors from now on
            this.server.once("error", (err: Error) => {
                reject(err);
            });
            this.server.close(() => {
                resolve();
            });
        });
    }

    /** returns socket to be re-used by CoapClients */
    public getSocket(): Socket {
        // FIXME: node-coap needs an explicit getter for this
        return this.server._sock as Socket;
    }

    /** returns server port number and indicates that server is running when larger than -1  */
    public getPort(): number {
        if (this.server._sock) {
            const socket = this.server._sock as Socket;
            return socket.address().port;
        } else {
            return -1;
        }
    }

    public expose(thing: ExposedThing, tdTemplate?: WoT.ExposedThingInit): Promise<void> {
        let urlPath = slugify(thing.title, { lower: true });

        if (this.things.has(urlPath)) {
            urlPath = Helpers.generateUniqueName(urlPath);
        }
        this.coreResources.set(urlPath, { urlPath, parameters: thingDescriptionParameters });

        debug(`CoapServer on port ${this.getPort()} exposes '${thing.title}' as unique '/${urlPath}'`);

        if (this.getPort() !== -1) {
            this.things.set(urlPath, thing);

            // fill in binding data
            for (const address of Helpers.getAddresses()) {
                for (const type of ContentSerdes.get().getOfferedMediaTypes()) {
                    const base: string =
                        this.scheme + "://" + address + ":" + this.getPort() + "/" + encodeURIComponent(urlPath);

                    for (const propertyName in thing.properties) {
                        const href = base + "/" + this.PROPERTY_DIR + "/" + encodeURIComponent(propertyName);
                        const form = new TD.Form(href, type);
                        ProtocolHelpers.updatePropertyFormWithTemplate(form, thing.properties[propertyName]);
                        if (thing.properties[propertyName].readOnly) {
                            form.op = ["readproperty"];
                        } else if (thing.properties[propertyName].writeOnly) {
                            form.op = ["writeproperty"];
                        } else {
                            form.op = ["readproperty", "writeproperty"];
                        }
                        if (thing.properties[propertyName].observable) {
                            if (!form.op) {
                                form.op = [];
                            }
                            form.op.push("observeproperty");
                            form.op.push("unobserveproperty");
                        }

                        thing.properties[propertyName].forms.push(form);
                        debug(`CoapServer on port ${this.getPort()} assigns '${href}' to Property '${propertyName}'`);
                    }

                    for (const actionName in thing.actions) {
                        const href = base + "/" + this.ACTION_DIR + "/" + encodeURIComponent(actionName);
                        const form = new TD.Form(href, type);
                        ProtocolHelpers.updateActionFormWithTemplate(form, thing.actions[actionName]);
                        form.op = "invokeaction";
                        thing.actions[actionName].forms.push(form);
                        debug(`CoapServer on port ${this.getPort()} assigns '${href}' to Action '${actionName}'`);
                    }

                    for (const eventName in thing.events) {
                        const href = base + "/" + this.EVENT_DIR + "/" + encodeURIComponent(eventName);
                        const form = new TD.Form(href, type);
                        ProtocolHelpers.updateEventFormWithTemplate(form, thing.events[eventName]);
                        form.op = ["subscribeevent", "unsubscribeevent"];
                        thing.events[eventName].forms.push(form);
                        debug(`CoapServer on port ${this.getPort()} assigns '${href}' to Event '${eventName}'`);
                    }
                } // media types
            } // addresses
        } // running

        return new Promise<void>((resolve, reject) => {
            resolve();
        });
    }

    public destroy(thingId: string): Promise<boolean> {
        debug(`CoapServer on port ${this.getPort()} destroying thingId '${thingId}'`);
        return new Promise<boolean>((resolve, reject) => {
            let removedThing: ExposedThing;
            for (const name of Array.from(this.things.keys())) {
                const expThing = this.things.get(name);
                if (expThing?.id === thingId) {
                    this.things.delete(name);
                    this.coreResources.delete(name);
                    removedThing = expThing;
                }
            }
            if (removedThing) {
                info(`CoapServer succesfully destroyed '${removedThing.title}'`);
            } else {
                info(`CoapServer failed to destroy thing with thingId '${thingId}'`);
            }
            resolve(removedThing !== undefined);
        });
    }

    private formatCoreLinkFormatResources() {
        return Array.from(this.coreResources.values())
            .map((resource) => {
                const formattedPath = `</${resource.urlPath}>`;
                const parameters = Array.from(resource.parameters?.entries() ?? []);

                const parameterValues = parameters.map((parameter) => {
                    const key = parameter[0];
                    const values = parameter[1].join(" ");
                    return `${key}="${values}"`;
                });

                return [formattedPath, ...parameterValues].join(";");
            })
            .join(",");
    }

    private handleWellKnownCore(req: IncomingMessage, res: OutgoingMessage) {
        if (req.method === "GET") {
            res.setOption("Content-Format", "application/link-format");
            res.code = "2.05";
            const payload = this.formatCoreLinkFormatResources();
            res.end(payload);
        } else {
            res.code = "4.05";
            res.end("Method Not Allowed");
        }
    }

    /**
     * Handles a CoAP request for an ExposedThing, negotiates the TD Content-Format and sends
     * a response.
     *
     * If a specific Content-Format for the TD is requested by a client, as indicated by
     * an Accept option, it will be set for the outgoing response if it is supported.
     * If no Accept option is set, the default Content-Format will be used as a fallback.
     *
     * If an Accept option is present but the Content-Format is not supported, the response
     * will be sent with a status code `4.06` (Not Acceptable) and an error
     * message as a diagnostic payload in accordance with RFC 7252, sections 5.10.4 and
     * 5.5.2.
     *
     * @param req The incoming request.
     * @param res The outgoing response.
     * @param thing The ExposedThing whose TD is requested.
     */
    private async handleTdRequest(req: IncomingMessage, res: OutgoingMessage, thing: ExposedThing) {
        if (req.method !== "GET") {
            res.code = "4.05";
            res.end("Method Not Allowed");
            return;
        }

        const accept = req.headers.Accept;

        const contentSerdes = ContentSerdes.get();

        if (accept == null || (typeof accept === "string" && contentSerdes.isSupported(accept))) {
            debug(`Received an available or no Content-Format (${accept}) in Accept option.`);
            const contentFormat = (accept as string) ?? ContentSerdes.TD;
            res.setHeader("Content-Format", contentFormat);
            res.code = "2.05";

            const content = contentSerdes.valueToContent(thing.getThingDescription(), undefined, contentFormat);
            const payload = await ProtocolHelpers.readStreamFully(content.body);
            debug(`Sending CoAP response for TD with Content-Format ${contentFormat}.`);
            res.end(payload);
        } else {
            debug(`Request contained an accept option with value ${accept} which is not supported.`);
            res.code = "4.06";
            res.end(`Content-Format ${accept} is not supported by this resource.`);
        }
    }

    private async handleRequest(req: IncomingMessage, res: OutgoingMessage) {
        debug(
            `CoapServer on port ${this.getPort()} received '${req.method}(${req._packet.messageId}) ${
                req.url
            }' from ${Helpers.toUriLiteral(req.rsinfo.address)}:${req.rsinfo.port}`
        );
        res.on("finish", () => {
            debug(
                `CoapServer replied with '${res.code}' to ${Helpers.toUriLiteral(req.rsinfo.address)}:${
                    req.rsinfo.port
                }`
            );
        });

        const requestUri = req.url;
        let contentType = req.headers["Content-Format"] as string;

        if (req.method === "PUT" || req.method === "POST") {
            if (!contentType && req.payload) {
                warn(
                    `CoapServer on port ${this.getPort()} received no Content-Format from ${Helpers.toUriLiteral(
                        req.rsinfo.address
                    )}:${req.rsinfo.port}`
                );
                contentType = ContentSerdes.DEFAULT;
            } else if (
                ContentSerdes.get().getSupportedMediaTypes().indexOf(ContentSerdes.getMediaType(contentType)) < 0
            ) {
                res.code = "4.15";
                res.end("Unsupported Media Type");
                return;
            }
        }

        // route request
        let parsedRequestUri = requestUri;
        if (parsedRequestUri.indexOf("?") !== -1) {
            parsedRequestUri = parsedRequestUri.substring(0, parsedRequestUri.indexOf("?"));
        }
        const segments = decodeURI(parsedRequestUri).split("/");

        if (segments[1] === "") {
            // no path -> list all Things
            if (req.method === "GET") {
                res.setHeader("Content-Format", ContentSerdes.DEFAULT);
                res.code = "2.05";
                const list = [];
                for (const address of Helpers.getAddresses()) {
                    // FIXME are Iterables really such a non-feature that I need array?
                    for (const name of Array.from(this.things.keys())) {
                        list.push(
                            this.scheme +
                                "://" +
                                Helpers.toUriLiteral(address) +
                                ":" +
                                this.getPort() +
                                "/" +
                                encodeURIComponent(name)
                        );
                    }
                }
                res.end(JSON.stringify(list));
            } else {
                res.code = "4.05";
                res.end("Method Not Allowed");
            }
            // resource found and response sent
            return;
        } else if (parsedRequestUri === "/.well-known/core") {
            this.handleWellKnownCore(req, res);
            return;
        } else {
            // path -> select Thing
            const thing = this.things.get(segments[1]);
            if (thing) {
                if (segments.length === 2 || segments[2] === "") {
                    // Thing root -> send TD
                    await this.handleTdRequest(req, res, thing);
                    return;
                } else if (segments[2] === this.PROPERTY_DIR) {
                    // sub-path -> select Property
                    const property = thing.properties[segments[3]];
                    if (property) {
                        if (req.method === "GET") {
                            // readproperty
                            if (req.headers.Observe === undefined) {
                                try {
                                    const options: WoT.InteractionOptions & { formIndex: number } = {
                                        formIndex: ProtocolHelpers.findRequestMatchingFormIndex(
                                            property.forms,
                                            this.scheme,
                                            req.url,
                                            contentType
                                        ),
                                    };
                                    const uriVariables = Helpers.parseUrlParameters(
                                        req.url,
                                        thing.uriVariables,
                                        property.uriVariables
                                    );
                                    if (!this.isEmpty(uriVariables)) {
                                        options.uriVariables = uriVariables;
                                    }
                                    const content = await thing.handleReadProperty(segments[3], options);
                                    res.setOption("Content-Format", content.type);
                                    res.code = "2.05";
                                    content.body.pipe(res);
                                } catch (err) {
                                    error(
                                        `CoapServer on port ${this.getPort()} got internal error on read '${requestUri}': ${
                                            err.message
                                        }`
                                    );
                                    res.code = "5.00";
                                    res.end(err.message);
                                }
                                // observeproperty
                            } else {
                                const listener = async (content: Content) => {
                                    try {
                                        res.setOption("Content-Format", content.type);
                                        res.code = "2.05";
                                        // send event data
                                        content.body.pipe(res, { end: true });
                                    } catch (err) {
                                        error(
                                            `CoapServer on port ${this.getPort()} got internal error on read '${requestUri}': ${
                                                err.message
                                            }`
                                        );
                                        res.code = "5.00";
                                        res.end(err.message);
                                    }
                                };

                                thing
                                    .handleObserveProperty(segments[3], listener, null)
                                    .then(() => res.end())
                                    .catch(() => res.end());

                                res.on("finish", (err: Error) => {
                                    if (err) {
                                        error(`CoapServer on port ${this.port} failed on observe with: ${err.message}`);
                                    }
                                    thing.handleUnobserveProperty(segments[3], listener, null);
                                });

                                setTimeout(
                                    () => thing.handleUnobserveProperty(segments[3], listener, null),
                                    60 * 60 * 1000
                                );
                            }
                            // writeproperty
                        } else if (req.method === "PUT") {
                            if (!property.readOnly) {
                                try {
                                    const options: WoT.InteractionOptions & { formIndex: number } = {
                                        formIndex: ProtocolHelpers.findRequestMatchingFormIndex(
                                            property.forms,
                                            this.scheme,
                                            req.url,
                                            contentType
                                        ),
                                    };
                                    await thing.handleWriteProperty(
                                        segments[3],
                                        new Content(contentType, Readable.from(req.payload)),
                                        options
                                    );
                                    res.code = "2.04";
                                    res.end("Changed");
                                } catch (err) {
                                    error(
                                        `CoapServer on port ${this.getPort()} got internal error on write '${requestUri}': ${
                                            err.message
                                        }`
                                    );
                                    res.code = "5.00";
                                    res.end(err.message);
                                }
                            } else {
                                res.code = "4.00";
                                res.end("Property readOnly");
                            }
                        } else {
                            res.code = "4.05";
                            res.end("Method Not Allowed");
                        }
                        // resource found and response sent
                        return;
                    } // Property exists?
                } else if (segments[2] === this.ACTION_DIR) {
                    // sub-path -> select Action
                    const action = thing.actions[segments[3]];
                    if (action) {
                        // invokeaction
                        if (req.method === "POST") {
                            const options: WoT.InteractionOptions & { formIndex: number } = {
                                formIndex: ProtocolHelpers.findRequestMatchingFormIndex(
                                    action.forms,
                                    this.scheme,
                                    req.url,
                                    contentType
                                ),
                            };
                            const uriVariables = Helpers.parseUrlParameters(
                                req.url,
                                thing.uriVariables,
                                action.uriVariables
                            );
                            if (!this.isEmpty(uriVariables)) {
                                options.uriVariables = uriVariables;
                            }
                            try {
                                const output = await thing.handleInvokeAction(
                                    segments[3],
                                    new Content(contentType, Readable.from(req.payload)),
                                    options
                                );
                                if (output) {
                                    res.setOption("Content-Format", output.type);
                                    res.code = "2.05";
                                    output.body.pipe(res, { end: true });
                                } else {
                                    res.code = "2.04";
                                    res.end();
                                }
                            } catch (err) {
                                error(
                                    `CoapServer on port ${this.getPort()} got internal error on invoke '${requestUri}': ${
                                        err.message
                                    }`
                                );
                                res.code = "5.00";
                                res.end(err.message);
                            }
                        } else {
                            res.code = "4.05";
                            res.end("Method Not Allowed");
                        }
                        // resource found and response sent
                        return;
                    } // Action exists?
                } else if (segments[2] === this.EVENT_DIR) {
                    // sub-path -> select Event
                    const event = thing.events[segments[3]];
                    if (event) {
                        // subscribeevent
                        if (req.method === "GET") {
                            if (req.headers.Observe === 0) {
                                // work-around to avoid duplicate requests (resend due to no response)
                                // (node-coap does not deduplicate when Observe is set)
                                const packet = res._packet;
                                packet.code = "0.00";
                                packet.payload = Buffer.from("");
                                packet.reset = false;
                                packet.ack = true;
                                packet.token = Buffer.alloc(0);

                                res._send(res, packet);

                                res._packet.confirmable = res._request.confirmable;
                                res._packet.token = res._request.token;
                                // end of work-around

                                const options: WoT.InteractionOptions & { formIndex: number } = {
                                    formIndex: ProtocolHelpers.findRequestMatchingFormIndex(
                                        event.forms,
                                        this.scheme,
                                        req.url,
                                        contentType
                                    ),
                                };
                                const uriVariables = Helpers.parseUrlParameters(
                                    req.url,
                                    thing.uriVariables,
                                    event.uriVariables
                                );
                                if (!this.isEmpty(uriVariables)) {
                                    options.uriVariables = uriVariables;
                                }
                                const listener = async (value: Content) => {
                                    try {
                                        // send event data
                                        debug(
                                            `CoapServer on port ${this.getPort()} sends '${
                                                segments[3]
                                            }' notification to ${Helpers.toUriLiteral(req.rsinfo.address)}:${
                                                req.rsinfo.port
                                            }`
                                        );
                                        res.setOption("Content-Format", value.type);
                                        res.code = "2.05";
                                        value.body.pipe(res);
                                    } catch (err) {
                                        debug(
                                            `CoapServer on port ${this.getPort()} failed '${segments[3]}' subscription`
                                        );
                                        res.code = "5.00";
                                        res.end();
                                    }
                                };

                                thing
                                    .handleSubscribeEvent(segments[3], listener, options)
                                    .then(() => res.end())
                                    .catch(() => res.end());
                                res.on("finish", () => {
                                    debug(
                                        `CoapServer on port ${this.getPort()} ends '${
                                            segments[3]
                                        }' observation from ${Helpers.toUriLiteral(req.rsinfo.address)}:${
                                            req.rsinfo.port
                                        }`
                                    );
                                    thing.handleUnsubscribeEvent(segments[3], listener, options);
                                });
                            } else if (req.headers.Observe > 0) {
                                debug(
                                    `CoapServer on port ${this.getPort()} sends '${
                                        segments[3]
                                    }' response to ${Helpers.toUriLiteral(req.rsinfo.address)}:${req.rsinfo.port}`
                                );
                                // node-coap does not support GET cancellation
                                res.code = "5.01";
                                res.end("node-coap issue: no GET cancellation, send RST");
                            } else {
                                debug(
                                    `CoapServer on port ${this.getPort()} rejects '${
                                        segments[3]
                                    }' read from ${Helpers.toUriLiteral(req.rsinfo.address)}:${req.rsinfo.port}`
                                );
                                res.code = "4.00";
                                res.end("No Observe Option");
                            }
                        } else {
                            res.code = "4.05";
                            res.end("Method Not Allowed");
                        }
                        // resource found and response sent
                        return;
                    } // Event exists?
                }
            } // Thing exists?
        }

        // resource not found
        res.code = "4.04";
        res.end("Not Found");
    }

    private isEmpty(obj: Record<string, unknown>) {
        for (const key in obj) {
            if (Object.prototype.hasOwnProperty.call(obj, key)) return false;
        }
        return true;
    }
}
