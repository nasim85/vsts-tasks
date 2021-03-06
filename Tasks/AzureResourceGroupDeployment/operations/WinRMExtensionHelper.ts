import networkManagementClient = require("./azure-rest/azure-arm-network");
import computeManagementClient = require("./azure-rest/azure-arm-compute");
import util = require("util");
import tl = require("vsts-task-lib/task");
import azure_utils = require("./AzureUtil");
import deployAzureRG = require("../models/DeployAzureRG");
import az = require("./azure-rest/azureModels");
import utils = require("./Utils");

export class WinRMExtensionHelper {
    private taskParameters: deployAzureRG.AzureRGTaskParameters;
    private resourceGroupName: string;
    private credentials;
    private subscriptionId: string;
    private fqdnMap;
    private winRmHttpsPortMap;
    private virtualMachines;
    private customScriptExtensionInstalled: boolean;
    private ruleAddedToNsg: boolean;
    private azureUtils: azure_utils.AzureUtil;
    private networkClient: networkManagementClient.NetworkManagementClient;
    private computeClient: computeManagementClient.ComputeManagementClient;

    constructor(taskParameters: deployAzureRG.AzureRGTaskParameters) {
        this.taskParameters = taskParameters;
        this.resourceGroupName = this.taskParameters.resourceGroupName;
        this.credentials = this.taskParameters.credentials;
        this.subscriptionId = this.taskParameters.subscriptionId;
        this.fqdnMap = {};
        this.winRmHttpsPortMap = {};
        this.customScriptExtensionInstalled = false;
        this.ruleAddedToNsg = false;

        this.networkClient = new networkManagementClient.NetworkManagementClient(this.credentials, this.subscriptionId);
        this.computeClient = new computeManagementClient.ComputeManagementClient(this.credentials, this.subscriptionId);
        this.azureUtils = new azure_utils.AzureUtil(this.taskParameters, this.computeClient, this.networkClient);
    }

    public async ConfigureWinRMExtension() {
        await this.AddInboundNatRulesOnLoadBalancers();
        await this.AddExtensionToVMsToConfigureWinRM();
        await this.AddNetworkSecurityRuleConfigForWinRMPort();
    }

    private async AddInboundNatRulesOnLoadBalancers(): Promise<void> {
        tl.debug("Trying to add Inbound Nat Rule to the LBs...");
        var resourceGroupDetails = await this.azureUtils.getResourceGroupDetails();
        for (var virtualMachine of resourceGroupDetails.VirtualMachines) {
            if (!utils.isNonEmpty(virtualMachine.WinRMHttpsPublicAddress)) {
                tl.debug("Adding Inbound Nat Rule for the VM: " + virtualMachine.Name);
                var lb: azure_utils.LoadBalancer;
                var nicId: string;
                for (var nic of virtualMachine.NetworkInterfaceIds) {
                    nicId = nic;
                    lb = resourceGroupDetails.LoadBalancers.find(l => !!l.BackendNicIds.find(id => id === nic));
                    if (lb) break;
                }

                if (lb) {
                    tl.debug("LB to which Inbound Nat Rule for VM " + virtualMachine.Name + " is to be added is " + lb.Id);
                    var frontendPort: number = this.GetFreeFrontendPort(lb);
                    await this.AddNatRuleInternal(lb.Id, nicId, frontendPort, 5986, virtualMachine.Name);
                    lb.FrontEndPortsInUse.push(frontendPort);
                }
                else {
                    tl.warning("There is no public address to reach the virtual machine x.");
                }
            }
            else {
                tl.debug("No need to add Inbound Nat rule for vm " + virtualMachine.Name);
            }
        }
    }

    private GetFreeFrontendPort(loadBalancer: azure_utils.LoadBalancer): number {
        var port: number = 5986;
        while (loadBalancer.FrontEndPortsInUse.find(p => p == port)) {
            port++;
        }
        tl.debug("Free port for Load balancer " + loadBalancer.Id + " is " + port);
        return port;
    }

    private async AddNatRuleInternal(loadBalancerId: string, networkInterfaceId: string, fronendPort: number, backendPort: number, virtualMachineName: string): Promise<void> {
        var random: number = Math.floor(Math.random() * 10000 + 100);
        var name: string = "winRMHttpsRule" + random.toString();
        var loadBalancers = await this.azureUtils.getLoadBalancers();
        var loadBalancer = loadBalancers.find(l => l.id == loadBalancerId);

        var InboundNatRuleProperties: az.InboundNatRuleProperties = {
            backendPort: backendPort,
            frontendPort: fronendPort,
            frontendIPConfiguration: { id: loadBalancer.properties.frontendIPConfigurations[0].id },
            protocol: "Tcp",
            idleTimeoutInMinutes: 4,
            enableFloatingIP: false
        }

        var rule: az.InboundNatRule = {
            id: "",
            name: name,
            properties: InboundNatRuleProperties
        };

        loadBalancer.properties.inboundNatRules.push(rule);
        var networkInterfaces = this.azureUtils.networkInterfaceDetails;
        var networkInterface = networkInterfaces.find(n => n.id == networkInterfaceId);
        var ipConfiguration: az.IPConfiguration;

        for (var ipc of networkInterface.properties.ipConfigurations) {
            for (var pool of loadBalancer.properties.backendAddressPools) {
                if (pool.properties.backendIPConfigurations && pool.properties.backendIPConfigurations.find(x => x.id == ipc.id)) {
                    if (!ipc.properties.loadBalancerInboundNatRules) {
                        ipc.properties.loadBalancerInboundNatRules = [];
                    }
                    ipConfiguration = ipc;
                    break;
                }
            }
        }

        if (!!loadBalancer && !!networkInterface) {
            await this.AddInboundNatRule(networkInterface, loadBalancer, ipConfiguration, fronendPort, virtualMachineName);
        }
    }

    private AddInboundNatRule(networkInterface: az.NetworkInterface, loadBalancer: az.LoadBalancer, ipConfiguration: az.IPConfiguration, fronendPort: number, virtualMachineName: string) {
        return new Promise<void>(async (resolve, reject) => {
            console.log(tl.loc("AddingInboundNatRule", virtualMachineName, loadBalancer.name));
            this.networkClient.loadBalancers.createOrUpdate(this.resourceGroupName, loadBalancer.name, loadBalancer, null, (error, result, request, response) => {
                if (error) {
                    console.log(tl.loc("InboundNatRuleAdditionFailed", loadBalancer.name, utils.getError(error)));
                    reject(tl.loc("InboundNatRuleAdditionFailed", loadBalancer.name, utils.getError(error)));
                }
                else {
                    var loadBalancerUpdated = <az.LoadBalancer>result;
                    var addedRule = loadBalancerUpdated.properties.inboundNatRules.find(r => r.properties.frontendPort == fronendPort);
                    ipConfiguration.properties.loadBalancerInboundNatRules.push(addedRule);
                    tl.debug("Updating the loadBalancerInboundNatRules of nic " + networkInterface.name);
                    this.networkClient.networkInterfaces.createOrUpdate(this.resourceGroupName, networkInterface.name, networkInterface, null,
                        (error2, result2, request2, response2) => {
                            if (error2) {
                                console.log(tl.loc("InboundNatRulesToNICFailed", networkInterface.name, utils.getError(error2)));
                                reject(tl.loc("InboundNatRulesToNICFailed", networkInterface.name, utils.getError(error2)));
                                return;
                            }
                            console.log(tl.loc("AddedTargetInboundNatRuleLB", networkInterface.name));
                            resolve();
                        });
                }
            });
        });
    }

    private async AddNetworkSecurityRuleConfigForWinRMPort() {
        var ruleName: string = "VSO-Custom-WinRM-Https-Port";
        var rulePriority: number = 3986;
        var winrmHttpsPort: string = "5986";
        var securityGroups = await this.GetNetworkSecurityGroups();
        if (securityGroups && securityGroups.length) {
            tl.debug("Trying to add a network security group rule");
            for (var i = 0; i < securityGroups.length; i++) {
                console.log(tl.loc("AddingSecurityRuleNSG", securityGroups[i]["name"]));
                var securityGrp = securityGroups[i];
                var securityGrpName = securityGrp["name"];

                tl.debug("Getting the network security rule config " + ruleName + " under security group " + securityGrpName);
                await this.TryAddNetworkSecurityRule(securityGrpName, ruleName, rulePriority, winrmHttpsPort);
            }
        }
    }

    private async AddInboundNetworkSecurityRule(securityGrpName, ruleName, rulePriority, winrmHttpsPort) {
        return new Promise<any>(async (resolve, reject) => {
            tl.debug("Adding inbound network security rule config " + ruleName + " with priority " + rulePriority + " for port " + winrmHttpsPort + " under security group " + securityGrpName);
            var securityRuleParameters = {
                properties: {
                    direction: "Inbound",
                    access: "Allow",
                    sourceAddressPrefix: "*",
                    sourcePortRange: "*",
                    destinationAddressPrefix: "*",
                    destinationPortRange: winrmHttpsPort,
                    protocol: "*",
                    priority: rulePriority
                }
            };
            this.networkClient.securityRules.createOrUpdate(this.resourceGroupName, securityGrpName, ruleName, securityRuleParameters, (error, result, request, response) => {
                if (error) {
                    tl.debug("Error in adding network security rule " + util.inspect(error, { depth: null }));
                    tl.debug("Failed to add inbound network security rule config " + ruleName + " with priority " + rulePriority + " for port " + winrmHttpsPort + " under security group " + securityGrpName);
                    rulePriority = rulePriority + 50;
                    return reject(utils.getError(error));
                }
                console.log(tl.loc("AddedSecurityRuleNSG", ruleName, rulePriority, winrmHttpsPort, securityGrpName, util.inspect(result, { depth: null })));
                return resolve();
            });
        });
    }

    private async AddInboundNetworkSecurityRuleWithRetry(retryCnt: number, securityGrpName, ruleName, rulePriority, winrmHttpsPort) {
        for (var i = 0; i < 3; i++) {
            try {
                await this.AddInboundNetworkSecurityRule(securityGrpName, ruleName, rulePriority, winrmHttpsPort);
                return;
            }
            catch (exception) {
            }
        }

        throw tl.loc("FailedAddingNSGRule3Times", securityGrpName);
    }

    private async TryAddNetworkSecurityRule(securityGrpName, ruleName, rulePriority: number, winrmHttpsPort: string) {
        var result = await this.GetSecurityRules(securityGrpName, ruleName);
        if (!result) {
            tl.debug("Rule " + ruleName + " not found under security Group " + securityGrpName);
            var maxRetries = 3;
            await this.AddInboundNetworkSecurityRuleWithRetry(maxRetries, securityGrpName, ruleName, rulePriority, winrmHttpsPort);
        }
        else {
            console.log(tl.loc("RuleExistsAlready", ruleName, securityGrpName));
        }
    }

    private GetSecurityRules(securityGrpName, ruleName): Promise<any> {
        return new Promise((resolve, reject) => {
            this.networkClient.securityRules.get(this.resourceGroupName, securityGrpName, ruleName, null, (error, result, request, response) => {
                if (error) {
                    return resolve(null); // Rule doesnt exist;
                }
                resolve(result);
            });
        });
    }

    private GetNetworkSecurityGroups(): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            this.networkClient.networkSecurityGroups.list(this.resourceGroupName, null, (error, result, request, response) => {
                if (error) {
                    tl.debug("Failed to get the list of NSG " + JSON.stringify(error));
                    reject(utils.getError(error));
                    return;
                }
                resolve(result);
            });
        });
    }

    private async AddExtensionToVMsToConfigureWinRM() {
        var resourceGroupDetails = await this.azureUtils.getResourceGroupDetails();
        for (var vm of this.azureUtils.vmDetails) {
            var resourceName = vm.name;
            var resourceId = vm.id;
            var vmResource = resourceGroupDetails.VirtualMachines.find(v => v.Name == resourceName);
            var resourceFQDN = vmResource.WinRMHttpsPublicAddress;
            var resourceWinRmHttpsPort = vmResource.WinRMHttpsPort
            if (vm["properties"]["storageProfile"]["osDisk"]["osType"] === 'Windows') {
                tl.debug("Enabling winrm for virtual machine " + resourceName);
                await this.AddWinRMExtension(resourceId, resourceName, resourceFQDN, vm["location"]);
            }
            else {
                tl.debug("WinRM extension cannot be enabled on the virtual machine: " + resourceName + "since the OS type is " +
                    vm.properties["storageProfile"]["osDisk"]["osType"]);
            }
        }
    }

    private async AddWinRMExtension(vmId: string, vmName: string, dnsName: string, location: string): Promise<any> {
        var extensionName: string = "CustomScriptExtension";
        var configWinRMScriptFile: string = "https://raw.githubusercontent.com/Azure/azure-quickstart-templates/master/201-vm-winrm-windows/ConfigureWinRM.ps1";
        var makeCertFile: string = "https://raw.githubusercontent.com/Azure/azure-quickstart-templates/master/201-vm-winrm-windows/makecert.exe";
        var winrmConfFile: string = "https://raw.githubusercontent.com/Azure/azure-quickstart-templates/master/201-vm-winrm-windows/winrmconf.cmd";
        var fileUris = [configWinRMScriptFile, makeCertFile, winrmConfFile];

        tl.debug("Adding custom script extension for virtual machine " + vmName);
        tl.debug("VM Location: " + location);
        tl.debug("VM DNS: " + dnsName);

        tl.debug("Checking if the extension " + extensionName + " is present on vm " + vmName);
        var result = await this.GetExtension(vmName, extensionName);
        var extensionStatusValid = false;
        if (result) {
            if (result["properties"]["settings"]["fileUris"].length == fileUris.length && fileUris.every((element, index) => { return element === result["properties"]["settings"]["fileUris"][index]; })) {
                tl.debug("Custom Script extension is for enabling Https Listener on VM" + vmName);
                if (result["properties"]["provisioningState"] === 'Succeeded') {
                    extensionStatusValid = await this.ValidateExtensionExecutionStatus(vmName, dnsName, extensionName, location, fileUris);
                }

                if (!extensionStatusValid) {
                    await this.RemoveExtensionFromVM(extensionName, vmName);
                }
            }
        }
        if (!extensionStatusValid) {
            await this.AddExtensionToVM(vmName, dnsName, extensionName, location, fileUris);
        }
        tl.debug("Addition of Custom Script Extension is completed");
    }

    private GetExtension(vmName: string, extensionName: string): Promise<any> {
        return new Promise<any>((resolve, reject) => {
            this.computeClient.virtualMachineExtensions.get(this.resourceGroupName, vmName, extensionName, null, async (error, result, request, response) => {
                if (error) {
                    tl.debug("Failed to get the extension!!");
                    return resolve(null);
                }
                resolve(result);
            });
        });
    }

    private async ValidateExtensionExecutionStatus(vmName: string, dnsName: string, extensionName: string, location: string, fileUris): Promise<boolean> {
        tl.debug("Validating the winrm configuration custom script extension status");

        return new Promise<boolean>((resolve, reject) => {
            this.computeClient.virtualMachines.get(this.resourceGroupName, vmName, { expand: 'instanceView' }, async (error, result, request, response) => {
                if (error) {
                    reject(tl.loc("FailedToFetchInstanceViewVM", utils.getError(error)));
                    return;
                }
                tl.debug("Got the Instance View of the virtualMachine " + vmName + ": " + JSON.stringify(result));
                var invalidExecutionStatus: boolean = false;
                if (result["properties"]["instanceView"] && result["properties"]["instanceView"]["extensions"]) {
                    var extensions = result["properties"]["instanceView"]["extensions"];
                    for (var extension of extensions) {
                        if (result["name"] === extensionName) {
                            for (var substatus of extension["substatuses"]) {
                                if (substatus["code"] && substatus["code"].indexOf("ComponentStatus/StdErr") >= 0 && !!substatus["message"] && substatus["message"] != "") {
                                    invalidExecutionStatus = true;
                                    break;
                                }
                            }
                            break;
                        }
                    }
                }
                tl.debug("Custom Script Extension status validated!!");
                resolve(!invalidExecutionStatus);
            });
        });
    }

    private async AddExtensionToVM(vmName: string, dnsName: string, extensionName: string, location: string, _fileUris): Promise<any> {
        var _commandToExecute: string = "powershell.exe -File ConfigureWinRM.ps1 " + dnsName;
        var _extensionType: string = 'Microsoft.Compute/virtualMachines/extensions';
        var _virtualMachineExtensionType: string = 'CustomScriptExtension';
        var _typeHandlerVersion: string = '1.7';
        var _publisher: string = 'Microsoft.Compute';

        var _protectedSettings = { commandToExecute: _commandToExecute };
        var parameters = {
            type: _extensionType,
            location: location,
            properties: {
                publisher: _publisher,
                type: _virtualMachineExtensionType,
                typeHandlerVersion: _typeHandlerVersion,
                settings: {
                    fileUris: _fileUris,
                    commandToExecute: _commandToExecute
                }
            }
        };

        console.log(tl.loc("AddExtension", extensionName, vmName));
        return new Promise<any>((resolve, reject) => {
            this.computeClient.virtualMachineExtensions.createOrUpdate(this.resourceGroupName, vmName, extensionName, parameters, async (error, result, request, response) => {
                if (error) {
                    reject(tl.loc("CreationOfExtensionFailed", utils.getError(error)));
                    return;
                }
                tl.debug("Addition of extension completed for vm" + vmName);
                if (result["properties"]["provisioningState"] != 'Succeeded') {
                    tl.debug("Provisioning State of CustomScriptExtension is not suceeded on vm " + vmName);
                    reject(tl.loc("ARG_SetExtensionFailedForVm", this.resourceGroupName, vmName, result));
                    return;
                }
                tl.debug("Provisioning of CustomScriptExtension on vm " + vmName + " is in Succeeded State");
                this.customScriptExtensionInstalled = true;
                console.log(tl.loc("AddedExtension", vmName));
                resolve();
            });
        });
    }

    private async RemoveExtensionFromVM(extensionName, vmName): Promise<any> {
        tl.debug("Removing the extension " + extensionName + "from vm " + vmName);
        //delete the extension
        return new Promise<any>((resolve, reject) => {
            this.computeClient.virtualMachineExtensions.deleteMethod(this.resourceGroupName, vmName, extensionName, async (error, result, request, response) => {
                if (error) {
                    tl.debug("Failed to delete the extension " + extensionName + " on the vm " + vmName + ", with error Message: " + util.inspect(error, { depth: null }));
                    reject(tl.loc("FailedToDeleteExtension"));
                    return;
                }

                tl.debug("Successfully removed the extension " + extensionName + " from the VM " + vmName);
                resolve();
            });
        });
    }
}