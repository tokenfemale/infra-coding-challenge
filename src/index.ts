import * as pulumi from "@pulumi/pulumi";
import * as aws from "@pulumi/aws";
import * as awsx from "@pulumi/awsx";
import * as dockerBuild from "@pulumi/docker-build";


interface AwsTagsPolicyConfig {
    requiredTags?: string[];
}

const tags = {
    "user:Project": pulumi.getProject(),
    "user:Stack": pulumi.getStack(),
}

const webRepo = new awsx.ecr.Repository("airtek-infra-team-web-repo", {
    forceDelete: true,
    tags: tags
});

const apiRepo = new awsx.ecr.Repository("airtek-infra-team-api-repo", {
    forceDelete: true,
    tags: tags
});


// Grab auth credentials for ECR.
const authToken = aws.ecr.getAuthorizationTokenOutput({
    registryId: webRepo.repository.id,
});

const apiImage = new dockerBuild.Image("infra-api", {

    // Configures the name of your existing buildx builder to use.
    // See the Pulumi.<stack>.yaml project file for the builder configuration.
    builder: {
        name: "cloud-timelinelin-my-cool-builder"
    },
    context: {
        location: "./infra-api",
    },
    // Enable exec to run a custom docker-buildx binary with support
    // for Docker Build Cloud (DBC).
    exec: true,
    push: true,
    tags: [pulumi.interpolate`${apiRepo.url}:latest`],
    platforms: [
        "linux/amd64",
    ],
    // Use the pushed image as a cache source.
    cacheFrom: [{
        registry: {
            ref: pulumi.interpolate`${apiRepo.url}:cache`,
        },
    }],
    cacheTo: [{
        registry: {
            imageManifest: true,
            ociMediaTypes: true,
            ref: pulumi.interpolate`${apiRepo.url}:cache`,
        },
    }],
    // Provide our ECR credentials.
    registries: [{
        address: apiRepo.url,
        password: authToken.password,
        username: authToken.userName,
    }]
}, { dependsOn: [apiRepo] });

const webImage = new dockerBuild.Image("infra-web", {

    // Configures the name of your existing buildx builder to use.
    // See the Pulumi.<stack>.yaml project file for the builder configuration.
    builder: {
        name: "cloud-timelinelin-my-cool-builder"
    },
    context: {
        location: "./infra-web",
    },
    // Enable exec to run a custom docker-buildx binary with support
    // for Docker Build Cloud (DBC).
    exec: true,
    push: true,
    tags: [pulumi.interpolate`${webRepo.url}:latest`],
    platforms: [
        "linux/amd64",
    ],
    // Use the pushed image as a cache source.
    cacheFrom: [{
        registry: {
            ref: pulumi.interpolate`${webRepo.url}:cache`,
        },
    }],
    cacheTo: [{
        registry: {
            imageManifest: true,
            ociMediaTypes: true,
            ref: pulumi.interpolate`${webRepo.url}:cache`,
        },
    }],
    // Provide our ECR credentials.
    registries: [{
        address: webRepo.url,
        password: authToken.password,
        username: authToken.userName,
    }],
}, { dependsOn: [webRepo, apiImage] });

// Allocate a new VPC with the default settings.
const vpc = new awsx.ec2.Vpc("vpc", {
    tags: tags
});

// Export a few properties to make them easy to use.
export const vpcId = vpc.vpcId;
export const privateSubnetIds = vpc.privateSubnetIds;
export const publicSubnetIds = vpc.publicSubnetIds;

const security_group = new aws.ec2.SecurityGroup("security-group", {
    vpcId: vpc.vpcId,
    name: "ecs-security-group",
    description: "Allow traffic within the cluster and load balancers",
    tags: tags
});

const security_group_ingress_rule = new aws.vpc.SecurityGroupIngressRule("security_group_ingress_rule", {
    fromPort: 0,
    toPort: 65535,
    ipProtocol: "tcp",
    referencedSecurityGroupId: security_group.id,
    securityGroupId: security_group.id,
    tags: tags
}, { dependsOn: security_group });

const security_group_egress_rule = new aws.vpc.SecurityGroupEgressRule("security_group_egress_rule", {
    fromPort: 0,
    toPort: 65535,
    ipProtocol: "tcp",
    referencedSecurityGroupId: security_group.id,
    securityGroupId: security_group.id,
    tags: tags
}, { dependsOn: security_group });

const ssl_security_group_egress_rule = new aws.vpc.SecurityGroupEgressRule("ssl_security_group_egress_rule", {
    description: "Allow access to make https requests and pull images",
    fromPort: 443,
    toPort: 443,
    ipProtocol: "tcp",
    cidrIpv4: "0.0.0.0/0",
    securityGroupId: security_group.id,
    tags: tags
}, { dependsOn: security_group });


const public_ingress = new aws.ec2.SecurityGroup("public-ingress", {
    vpcId: vpc.vpcId,
    name: "ingress-security-group",
    description: "Allow traffic from outside",
    ingress: [{
        fromPort: 80,
        toPort: 80,
        protocol: "TCP",
        cidrBlocks: ["0.0.0.0/0"]
    }],
    tags: tags
});

const cluster = new aws.ecs.Cluster("airtek-infra-team-test",
    {
        tags: tags
    }
);


const frontendLb = new awsx.lb.ApplicationLoadBalancer("frontend-lb", {
    internal: false,
    listener: {
        port: 80
    },
    defaultTargetGroup: {
        healthCheck: {
            enabled: true,
            path: '/',
            port: '5000',
        },
        port: 5000,
        name: 'frontend-lb',
        protocol: 'HTTP'
    },
    subnetIds: publicSubnetIds,
    securityGroups: [security_group.id, public_ingress.id],
    tags: tags
});

const backendLb = new awsx.lb.ApplicationLoadBalancer("backend-lb", {
    internal: true,
    listener: {
        port: 80
    },
    defaultTargetGroup: {
        healthCheck: {
            enabled: true,
            path: '/WeatherForecast',
            port: '5000'
        },
        port: 5000,
        name: 'backend-lb',
        protocol: 'HTTP'
    },
    subnetIds: privateSubnetIds,
    securityGroups: [security_group.id],
    tags: tags
});



const backend = new awsx.ecs.FargateService("backend", {
    cluster: cluster.arn,
    taskDefinitionArgs: {
        container: {
            name: "air-tek-backend",
            image: apiImage.ref,
            cpu: 128,
            memory: 128,
            essential: true,
            portMappings: [
                {
                    containerPort: 5000,
                    targetGroup: backendLb.defaultTargetGroup,
                },
            ],
        },
    },
    loadBalancers: [
        {
            containerName: "air-tek-backend",
            containerPort: 5000,
            targetGroupArn: backendLb.defaultTargetGroup.arn
        }
    ],
    networkConfiguration: {
        subnets: privateSubnetIds,
        assignPublicIp: false,
        securityGroups: [security_group.id]
    },
    tags: tags
});

const frontend = new awsx.ecs.FargateService("frontend", {
    cluster: cluster.arn,
    taskDefinitionArgs: {
        container: {
            name: "air-tek-frontend",
            image: webImage.ref,
            cpu: 128,
            memory: 128,
            essential: true,
            portMappings: [
                {
                    containerPort: 5000,
                    targetGroup: frontendLb.defaultTargetGroup,
                },
            ],
            environment: [
                {
                    name: 'ApiAddress',
                    value: pulumi.interpolate`http://${backendLb.loadBalancer.dnsName}/WeatherForecast`
                }
            ]
        },
    },
    loadBalancers: [
        {
            containerName: "air-tek-frontend",
            containerPort: 5000,
            targetGroupArn: frontendLb.defaultTargetGroup.arn
        }
    ],
    networkConfiguration: {
        subnets: privateSubnetIds,
        assignPublicIp: false,
        securityGroups: [security_group.id]
    },
    tags: tags
});

export const url = pulumi.interpolate`http://${frontendLb.loadBalancer.dnsName}`;